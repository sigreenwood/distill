import path from 'node:path';
import { app, dialog, shell, powerMonitor } from 'electron';
import { appSupportDir, userVocabularyDir, expandHome, migrationNotes } from './paths.js';
import { bundledResourcesDir, bundledRoot } from './bundledResources.js';
import { createLogger, type Logger } from './logger.js';
import {
  loadConfig,
  saveConfig,
  normaliseConfig,
  ConfigMissingError,
  type AppConfig,
} from './config.js';
import { openDatabase, State } from './state.js';
import { seedIfEmpty } from './seed.js';
import { createTray, type TrayHandle } from './tray.js';
import { OllamaClient, preflightMessage } from './ollama.js';
import { KeychainCredentialStore, migratePasswordToKeychain } from './keychain.js';
import { connect, PlaudNotAuthenticatedError } from './plaudAccount.js';
import { Poller, loadProcessedElsewhereIds } from './poller.js';
import { Worker } from './worker.js';
import { notify } from './notifications.js';
import { recordCompletion, TIP_JAR_URL } from './tipJar.js';
import {
  configureWindows,
  openInbox,
  openSettings,
  openHistory,
  openClientBrief,
  openClientRegister,
  openSetup,
  showUpdateWindow,
  closeAll,
} from './windows.js';
import {
  registerIpcHandlers,
  broadcastInboxChanged,
  broadcastRecording,
  broadcastFocusRecording,
} from './ipc.js';
import { getInstallationStatus } from './pythonEnv.js';
import { importLocalFile, LocalImportError } from './localImport.js';
import { adoptTracks } from './callTracks.js';
import { startCallWatch, callAppName, type CallWatch } from './callWatch.js';
import {
  checkForUpdate,
  downloadUpdate,
  shouldNotify,
  loadMemory,
  saveMemory,
  UpdateError,
  type UpdateInfo,
} from './updateCheck.js';
import { renderUpdatePage } from './updateNotes.js';
import { createRecorder, RecorderError, type Recorder } from './recorder.js';
import { migrateScopeRenames, migrateVocabularyToUserDir } from './vocabulary.js';
import { startSweepSchedule, sweepStateFor, nodeFs } from './audioRetention.js';
import { startModelUpdateCheck } from './modelUpdateCheck.js';
import { withToolDirs } from './toolPath.js';

// Before anything spawns ffmpeg, ffprobe or Python — see toolPath.ts.
process.env.PATH = withToolDirs(process.env.PATH);

app.dock?.hide();

let recorder: Recorder | null = null;
let callWatch: CallWatch | null = null;

// --- updates ---------------------------------------------------------------
// Suggestion-only (see updateCheck.ts): find, tell, and on a click download and
// hand the .pkg to the macOS installer. Never installs by itself.

let availableUpdate: UpdateInfo | null = null;
let updateBusy = false;
const updatesDir = (): string => path.join(appSupportDir(), 'updates');
const updateMemoryFile = (): string => path.join(updatesDir(), 'state.json');

async function runUpdateCheck(manual: boolean, state: State, log: Logger): Promise<void> {
  if (updateBusy) return;
  updateBusy = true;
  try {
    const info = await checkForUpdate(app.getVersion());
    availableUpdate = info;
    trayHandle?.setUpdateAvailable(info?.version ?? null);
    if (!info) {
      log.info({ current: app.getVersion() }, 'update check: up to date');
      if (manual) {
        void dialog.showMessageBox({
          type: 'info',
          message: 'distill is up to date',
          detail: `You have ${app.getVersion()}, the latest release.`,
        });
      }
      return;
    }
    log.info({ current: app.getVersion(), available: info.version }, 'update check: newer release found');
    if (manual) {
      updateBusy = false;
      await offerUpdate(info, state, log);
      return;
    }
    const mem = loadMemory(updateMemoryFile());
    if (shouldNotify(mem, info.version)) {
      saveMemory(updateMemoryFile(), { ...mem, notified: info.version });
      notify({
        title: `distill ${info.version} is available`,
        body: 'Click to review it. Nothing is installed unless you say so.',
        onClick: () => void offerUpdate(info, state, log),
      });
    }
  } catch (e) {
    const msg = e instanceof UpdateError ? e.userMessage : String(e);
    log.warn({ err: String(e) }, 'update check failed');
    if (manual) dialog.showErrorBox('distill — update check', msg);
  } finally {
    updateBusy = false;
  }
}

async function offerUpdate(info: UpdateInfo, state: State, log: Logger): Promise<void> {
  if (updateBusy) return;
  // The changelog comes first, in full, and nothing is downloaded until the
  // user has seen it and pressed Download and Install.
  const choice = await showUpdateWindow(
    renderUpdatePage(info, app.getVersion(), { processing: state.processingSummary().running > 0 }),
    `distill ${info.version} — what's new`,
  );
  if (choice === 'page') {
    void shell.openExternal(info.pageUrl);
    return;
  }
  if (choice === 'skip') {
    saveMemory(updateMemoryFile(), { ...loadMemory(updateMemoryFile()), skipped: info.version });
    return;
  }
  if (choice !== 'install') return;

  if (recorder?.startedAt() != null) {
    dialog.showErrorBox('distill — update', 'A call is being recorded. Stop the recording first, then update.');
    return;
  }
  updateBusy = true;
  try {
    notify({ title: `Downloading distill ${info.version}`, body: 'You will be asked before anything is installed.', silent: true });
    const pkg = await downloadUpdate(info, updatesDir(), app.getVersion(), undefined);
    log.info({ pkg }, 'update downloaded and verified');
    const ready = await dialog.showMessageBox({
      type: 'question',
      message: `distill ${info.version} is ready to install`,
      detail: 'distill will quit and the macOS installer will open. Open distill again from Applications when it finishes.',
      buttons: ['Quit and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (ready.response !== 0) return;
    if (recorder?.startedAt() != null) {
      dialog.showErrorBox('distill — update', 'A call started recording. Stop it first, then update.');
      return;
    }
    const failed = await shell.openPath(pkg);
    if (failed) throw new UpdateError(`The installer could not be opened (${failed}). The file is at ${pkg}.`);
    app.quit();
  } catch (e) {
    log.error({ err: String(e) }, 'update install failed');
    dialog.showErrorBox('distill — update', e instanceof UpdateError ? e.userMessage : String(e));
  } finally {
    updateBusy = false;
  }
}

function getRecorder(state: State, log: Logger): Recorder {
  return (recorder ??= createRecorder({
    logger: log,
    helperPath: path.join(bundledRoot(), app.isPackaged ? 'bin' : 'native/capture/build', 'distill-capture'),
    scratchRoot: path.join(appSupportDir(), 'capture'),
    importFile: async (mp3, tracks) => {
      const result = await importLocalFile(mp3, { state, logger: log });
      if (tracks) {
        try {
          adoptTracks(result.audioPath, tracks);
        } catch (e) {
          // The recording is safely imported; it just won't be speaker-labelled.
          log.warn({ err: String(e), id: result.recordingId }, 'could not store call tracks');
        }
      }
      trayHandle?.refresh();
      broadcastInboxChanged();
      notify({
        title: 'Call recorded',
        body: 'It is in your inbox, ready to process.',
        onClick: () => {
          openInbox(undefined, result.recordingId);
          broadcastFocusRecording(result.recordingId);
        },
      });
    },
    onWarning: (body) => notify({ title: 'distill — call recording', body }),
    onChange: (startedAt) => {
      trayHandle?.setRecording(startedAt);
      broadcastRecording(startedAt);
    },
  }));
}

/** Start or stop the Zoom/Teams watcher to match the setting. Idempotent. */
function applyCallDetection(enabled: boolean, state: State, log: Logger): void {
  callWatch?.stop();
  callWatch = null;
  if (!enabled) return;
  callWatch = startCallWatch(
    path.join(bundledRoot(), app.isPackaged ? 'bin' : 'native/capture/build', 'distill-callwatch'),
    log,
    (ev) => {
      const recording = recorder?.startedAt() != null;
      const name = callAppName(ev.app);
      const subject = name === 'A' ? 'A call' : `A ${name} call`;
      if (ev.active && !recording) {
        notify({
          title: `${subject} has started`,
          body: 'Click to record it. Nothing is recorded unless you do.',
          onClick: () => void toggleCallRecording(state, log),
        });
      } else if (!ev.active && recording) {
        notify({
          title: `${subject} has ended`,
          body: 'Click to stop recording and add it to the inbox.',
          onClick: () => void toggleCallRecording(state, log),
        });
      }
    },
  );
}

async function toggleCallRecording(state: State, log: Logger): Promise<void> {
  const rec = getRecorder(state, log);
  try {
    if (rec.startedAt() === null) await rec.start();
    else await rec.stop();
  } catch (e) {
    const msg = e instanceof RecorderError ? e.userMessage : `Recording failed: ${String(e)}`;
    log.error({ err: String(e) }, 'call recording toggle failed');
    dialog.showErrorBox('distill — call recording', msg);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// With no Dock icon, a tray-only window is the app's only surface — and on
// notched displays the tray icon itself can end up hidden in the overflow
// behind the notch. "Just try opening the app again" is the natural thing a
// user does when they can't find it, so both of macOS's relaunch signals
// need to actually show the window instead of silently doing nothing:
// second-instance (a second process attempt) and activate (Finder/Spotlight
// reactivating the already-running app, e.g. a Dock click would fire this
// too if there were a Dock icon).
app.on('second-instance', () => {
  if (appReady) openInbox();
});
app.on('activate', () => {
  if (appReady) openInbox();
});

let trayHandle: TrayHandle | null = null;
let state: State | null = null;
let poller: Poller | null = null;
let worker: Worker | null = null;
let logger: Logger | null = null;
let stopAudioSweep: (() => void) | null = null;
let stopModelCheck: (() => void) | null = null;
let plaudStore: KeychainCredentialStore | null = null;
// Polling for new recordings needs neither Python nor Ollama, so it starts
// even while the Setup window repairs the venv; transcription waits for
// setup (pythonReady). See continueBootstrap.
let pythonReady = false;
let bootstrapped = false;
/** How long startup waits on the Keychain before carrying on without Plaud. */
const KEYCHAIN_WAIT_MS = 15_000;

// macOS delivers open-file (dock drop / "Open With") before whenReady on a
// cold launch. Queue those and replay once the app has bootstrapped.
const pendingFileDrops: string[] = [];
let appReady = false;

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (appReady) {
    void handleFileDrop(filePath);
  } else {
    pendingFileDrops.push(filePath);
  }
});

async function handleFileDrop(filePath: string): Promise<void> {
  if (!state) return;
  const log = logger;
  try {
    const result = await importLocalFile(filePath, {
      state,
      logger: log ?? ({ info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
    });
    trayHandle?.refresh();
    broadcastInboxChanged();
    openInbox(undefined, result.recordingId);
    broadcastFocusRecording(result.recordingId);
  } catch (e) {
    const msg = e instanceof LocalImportError ? e.userMessage : `Import failed: ${String(e)}`;
    log?.warn({ err: String(e), path: filePath }, 'file drop import failed');
    dialog.showErrorBox('distill — import failed', msg);
  }
}

app.whenReady().then(async () => {
  const resourcesDir = bundledResourcesDir();
  const appSupportDirPath = appSupportDir();

  try {
    migrateScopeRenames(userVocabularyDir());
    migrateVocabularyToUserDir(path.join(bundledResourcesDir(), 'vocabulary'), userVocabularyDir());
  } catch (e) {
    console.warn('vocabulary migration threw:', e);
  }

  let cfg: AppConfig;
  try {
    cfg = loadConfig(resourcesDir);
  } catch (e) {
    if (e instanceof ConfigMissingError) {
      dialog.showErrorBox(
        'distill — install looks broken',
        `No config file at ${e.expectedPath}, and no bundled example to bootstrap from. The app install may be incomplete. Try reinstalling distill, or place a config.json at the path above.`,
      );
      app.quit();
      return;
    }
    throw e;
  }

  const localLogger = createLogger({ level: cfg.logLevel, pretty: !app.isPackaged });
  logger = localLogger;
  // Version and bundle path go in the first line deliberately. A .pkg that
  // silently declines to replace the app leaves you running an old build
  // with no indication anywhere, and every bug report after that is against
  // the wrong code. appPath is here too because "which copy is running" is
  // the other half of that question.
  localLogger.info(
    {
      version: app.getVersion(),
      appPath: app.getAppPath(),
      packaged: app.isPackaged,
      cfg,
      appSupportDir: appSupportDirPath,
    },
    'distill starting',
  );
  // Report any pre-rename directory migration. Paths resolve at module
  // load, before the logger exists, so the notes are replayed here.
  for (const note of migrationNotes()) {
    localLogger.info({ migration: note }, 'path migration');
  }

  let localState: State;
  try {
    const db = openDatabase();
    localState = new State(db);
    state = localState;
    const seedResult = seedIfEmpty(state, resourcesDir);
    for (const note of seedResult.notes) localLogger.info(note);
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    localLogger.fatal({ err: msg }, 'startup failed during SQLite init');
    dialog.showErrorBox('distill failed to start', msg);
    app.quit();
    return;
  }

  configureWindows({
    preloadPath: path.join(app.getAppPath(), 'out', 'preload', 'index.js'),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL ?? undefined,
    rendererDistDir: path.join(app.getAppPath(), 'out', 'renderer'),
  });

  const applyConfigUpdate = (patch: Partial<AppConfig>): AppConfig => {
    cfg = normaliseConfig({ ...cfg, ...patch });
    return cfg;
  };

  registerIpcHandlers({
    state: localState,
    logger: localLogger,
    resourcesDir,
    getConfig: () => cfg,
    toggleRecording: () => toggleCallRecording(localState, localLogger),
    getRecordingStartedAt: () => recorder?.startedAt() ?? null,
    onDetectCallsChanged: (enabled) => applyCallDetection(enabled, localState, localLogger),
    applyConfigUpdate,
    // Lazy getter — the worker is constructed after Plaud connects, below.
    // Any IPC that fires before then will get null, which the pipeline
    // handlers tolerate (nudge and cancel are no-ops without a worker).
    getWorker: () => worker,
    // Plaud credential store is constructed later in this whenReady
    // block, so use a getter so the IPC handlers see it once it exists.
    getPlaudStore: () => plaudStore,
    // Sign-out only now — see onPlaudSignedIn below for sign-in, which
    // reconnects live instead of asking for a restart.
    onPlaudCredentialsChanged: () => {
      notify({
        title: 'distill — restart to apply',
        body: 'Restart distill to stop syncing with the signed-out Plaud account.',
      });
    },
    // Signing in while already connected (switching accounts) still needs
    // a restart: worker/poller hold a reference to the old PlaudClient,
    // and swapping that live is more risk than this fix is worth. Signing
    // in for the first time (the actual bug — see BACKLOG.md's "Live
    // re-connect after a Plaud sign-in") reconnects immediately instead.
    onPlaudSignedIn: () => {
      if (poller) {
        notify({
          title: 'distill — restart to apply',
          body: 'Restart distill to switch to the new Plaud account.',
        });
        return;
      }
      void connectPlaudAndStartPipeline().then((started) => {
        if (started) {
          trayHandle?.setWarning('plaud', null);
          notify({ title: 'distill — signed in', body: 'Syncing with Plaud has started.' });
        }
      });
    },
    onStateChanged: () => trayHandle?.refresh(),
    onSetupComplete: () => {
      pythonReady = true;
      // Polling already started alongside the Setup window; only the
      // worker was waiting for the venv.
      if (bootstrapped) worker?.recoverOnStartup();
      else void continueBootstrap();
    },
  });

  const devVenvPath = path.join(app.getAppPath(), 'python', '.venv', 'bin', 'python');
  const installStatus = getInstallationStatus(devVenvPath);
  localLogger.info(
    {
      kind: installStatus.kind,
      pythonPath: installStatus.kind === 'ready' ? installStatus.pythonPath : null,
      source: installStatus.kind === 'ready' ? installStatus.source : undefined,
      // Why it isn't ready — otherwise every cause looks the same here.
      venvStatus: installStatus.kind === 'ready' ? undefined : installStatus.venvStatus,
    },
    'python install status',
  );
  if (installStatus.kind === 'ready') {
    pythonReady = true;
    await continueBootstrap();
  } else {
    // Setup repairs the venv in its window; meanwhile the tray and polling
    // still start. Gating everything on setup left polling off for up to
    // 9.7 days in Sep 2026 while setup was quit or failed repeatedly.
    localLogger.info({ reason: installStatus.kind }, 'opening setup window; polling starts anyway');
    openSetup();
    await continueBootstrap();
  }

  /**
   * Connects to Plaud and starts the worker + poller. Idempotent — a
   * no-op if a poller already exists — so calling this again after a
   * successful sign-in (see onPlaudSignedIn below) never creates a
   * duplicate poller. Returns whether the pipeline is now running
   * (either it already was, or this call just started it).
   *
   * Previously this was inline in continueBootstrap and only ever ran
   * once, at startup: if Plaud wasn't authenticated yet, worker/poller
   * stayed null for the rest of the app's life, and signing in later
   * from Settings -> Sources did nothing until a manual restart. See
   * BACKLOG.md's "Live re-connect after a Plaud sign-in".
   */
  async function connectPlaudAndStartPipeline(): Promise<boolean> {
    if (poller) return true;
    if (!trayHandle || !plaudStore) return false;
    const tray = trayHandle;
    try {
      const conn = connect(plaudStore);
      localLogger.info({ region: conn.region }, 'Plaud connection ready');

      worker = new Worker(
        {
          state: localState,
          // Pass a getter rather than `cfg` directly so the worker picks up
          // Settings edits (output destinations, Ollama model, etc.) between
          // steps without needing an app restart.
          getConfig: () => cfg,
          logger: localLogger,
          ollama: new OllamaClient(cfg.ollama.host),
          plaud: conn.client,
          packageDir: app.getAppPath(),
          // Used by prettifyError for path-aware messages (EACCES,
          // mlx_whisper missing). Both come from electron / paths
          // so they're set here rather than imported in errorMessages
          // (which keeps that module test-runnable in plain Node).
          appSupportDir: appSupportDirPath,
          isPackaged: app.isPackaged,
          getSystemIdleSeconds: () => powerMonitor.getSystemIdleTime(),
          notifyUser: (title, body) => notify({ title, body }),
        },
        {
          onStateChanged: () => {
            trayHandle?.refresh();
            broadcastInboxChanged();
          },
          onError: (id, message) => {
            const row = localState.getRecordingJoined(id);
            const label = row
              ? (row.client_name && row.meeting_type_name
                  ? `${row.client_name} — ${row.meeting_type_name}`
                  : row.filename)
              : id;
            notify({
              title: 'distill — summary failed',
              // The friendly message from errorMessages says what to do
              // about it; putting it in the notification means the user
              // doesn't have to go hunting for why the tray went amber.
              body: `${label}\n${message}`,
              onClick: () => {
                openInbox(undefined, id);
                broadcastFocusRecording(id);
              },
            });
          },
          onComplete: (id) => {
            const row = localState.getRecordingJoined(id);
            if (!row) return;
            localLogger.info(
              { id, client: row.client_name, path: row.markdown_path },
              'pipeline complete',
            );
            notify({
              title: 'Summary ready',
              body:
                row.client_name && row.meeting_type_name
                  ? `${row.client_name} — ${row.meeting_type_name}`
                  : row.filename,
              onClick: () => {
                if (row.markdown_path) shell.showItemInFolder(row.markdown_path);
              },
            });
            try {
              const outcome = recordCompletion(localState);
              if (outcome.kind === 'threshold-just-hit') {
                localLogger.info(
                  { count: outcome.count },
                  'tip-jar threshold reached — firing one-shot notification',
                );
                notify({
                  title: `${outcome.count} summaries done — nice work`,
                  body: "Glad distill is earning its keep. If you'd like to support development, you can keep me caffeinated. Tap to open the tip jar.",
                  onClick: () => {
                    void shell
                      .openExternal(TIP_JAR_URL)
                      .catch((err) =>
                        localLogger.warn(
                          { err: String(err) },
                          'failed to open tip-jar URL from notification click',
                        ),
                      );
                  },
                });
              }
            } catch (e) {
              localLogger.warn({ err: String(e), id }, 'tip-jar bookkeeping failed (non-fatal)');
            }
          },
        },
      );
      if (pythonReady) worker.recoverOnStartup();
      else localLogger.info('transcription waits for Python setup to finish; polling starts now');

      // Wakes the worker even with no other trigger event (a tag save, a
      // retry, ...), so an idle/overnight processingSchedule window that
      // opens while the app just sits there still gets noticed. nudge()
      // is a no-op when the worker's already running or nothing's
      // claimable, so this is cheap to run unconditionally rather than
      // starting/stopping it as Settings changes the schedule mode.
      setInterval(() => {
        if (pythonReady) worker?.nudge();
      }, 60_000);

      poller = new Poller({
        state: localState,
        client: conn.client,
        intervalMinutes: cfg.pollIntervalMinutes,
        logger: localLogger,
        // Polling is paused when either the master switch is on or the
        // dedicated polling flag is set. The poller treats this as a
        // "don't start new work" signal and emits a `skipped-paused`
        // result without contacting Plaud.
        shouldPause: () => cfg.paused.all || cfg.paused.polling,
        initialPollInboxCount: () => cfg.initialPollInboxCount,
        minRecordingMinutes: () => cfg.minRecordingMinutes,
        // Cross-machine completion lookup. Scans the configured Markdown
        // output dir for files whose frontmatter recording_id matches a
        // recording the poller is about to insert; matches are inserted
        // as `complete` / `processed_externally = 1` rather than going
        // to the inbox to be re-processed. When Markdown output is
        // disabled, the lookup returns an empty Map and behaviour falls
        // back to single-machine semantics.
        loadProcessedElsewhere: async () => {
          if (!cfg.outputs.markdown.enabled) return new Map();
          const dir = expandHome(cfg.outputs.markdown.dir);
          return loadProcessedElsewhereIds(dir);
        },
        onPoll: (result, fresh) => {
          tray.setLastPoll(result);
          tray.refresh();
          if (result.kind === 'ok' && fresh.length > 0) {
            for (const r of fresh) {
              const seconds = typeof r.duration === 'number' ? r.duration / 1000 : null;
              notify({
                title: 'New recording',
                body: `${r.filename} · ${formatDuration(seconds)} — tap to tag`,
                onClick: () => {
                  openInbox(undefined, r.id);
                  broadcastFocusRecording(r.id);
                },
              });
            }
          }
        },
      });
      poller.start();
      return true;
    } catch (e) {
      if (e instanceof PlaudNotAuthenticatedError) {
        localLogger.error({ err: e.message }, 'Plaud not authenticated');
        notify({
          title: 'distill — sign in needed',
          body: 'Open Settings -> Sources to sign in to Plaud.',
        });
        tray.setWarning('plaud', 'Plaud: not signed in');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        localLogger.error({ err: msg }, 'failed to start Plaud poller');
        tray.setWarning('plaud', `Plaud: ${msg}`);
      }
      return false;
    }
  }

  /** Move a legacy config.json Plaud password into the Keychain (touches the Keychain, so only after prime()). */
  async function migratePlaudPassword(): Promise<void> {
    try {
      const result = await migratePasswordToKeychain();
      if (result === 'migrated') {
        localLogger.info('migrated Plaud password from config.json to Keychain');
      } else if (result === 'kept-as-fallback') {
        localLogger.info(
          'Plaud password still in config.json (no Keychain copy yet); will migrate on first sign-in',
        );
      }
    } catch (e) {
      localLogger.warn(
        { err: String(e) },
        'password migration failed (non-fatal; legacy file path still works)',
      );
    }
  }

  async function continueBootstrap(): Promise<void> {
    if (bootstrapped) return;
    bootstrapped = true;
    const tray = createTray({
      state: localState,
      logger: localLogger,
      resourcesDir,
      getConfig: () => cfg,
      onSyncNow: async () => {
        if (!poller) return;
        localLogger.info('manual sync requested');
        await poller.syncNow();
      },
      onOpenInbox: (bounds) => {
        openInbox(bounds);
        broadcastInboxChanged();
      },
      onOpenErrors: (bounds) => {
        // Focus the first errored row so the user lands on the thing the
        // ⚠ is actually about, rather than the top of the list.
        const [firstErrored] = localState.listErroredIds();
        openInbox(bounds, firstErrored);
        broadcastInboxChanged();
        if (firstErrored) broadcastFocusRecording(firstErrored);
      },
      onDismissErrors: () => {
        const cleared = localState.dismissAllErrors();
        localLogger.info({ cleared }, 'errors dismissed from tray');
        trayHandle?.refresh();
        broadcastInboxChanged();
      },
      onOpenSettings: () => openSettings(),
      onOpenHistory: () => openHistory(),
      onOpenClientBrief: () => openClientBrief(),
      onOpenClientRegister: () => openClientRegister(),
      onToggleRecording: () => {
        void toggleCallRecording(localState, localLogger);
      },
      onCheckForUpdates: () => {
        if (availableUpdate) void offerUpdate(availableUpdate, localState, localLogger);
        else void runUpdateCheck(true, localState, localLogger);
      },
      onPauseChange: (nextPause) => {
        const updated = applyConfigUpdate({ paused: nextPause });
        saveConfig(updated);
        trayHandle?.refresh();
        worker?.nudge();
        localLogger.info({ paused: nextPause }, 'pause settings changed');
      },
    });
    trayHandle = tray;

    applyCallDetection(cfg.detectCalls, localState, localLogger);
    // Update checks: a dev build reports Electron's own version, so only packaged builds poll.
    if (app.isPackaged) {
      const tick = () => {
        if (cfg.checkForUpdates) void runUpdateCheck(false, localState, localLogger);
      };
      setTimeout(tick, 45_000);
      setInterval(tick, 6 * 60 * 60 * 1000);
    }
    // Give a helper orphaned by a crash a moment to notice and finalise its files first.
    setTimeout(() => {
      void getRecorder(localState, localLogger)
        .recoverInterrupted()
        .then((n) => {
          if (n > 0) notify({ title: 'Call recovered', body: `Added ${n} call recording${n === 1 ? '' : 's'} from an earlier session to your inbox.` });
        })
        .catch((e) => localLogger.error({ err: String(e) }, 'call recovery failed'));
    }, 5000);

    // Checked at launch, then every 2 minutes while it's failing, so the
    // tray's amber warning clears once Ollama is started (it used to stay
    // until distill was restarted).
    const checkOllama = async (notifyOnFailure: boolean): Promise<boolean> => {
      try {
        const pf = await new OllamaClient(cfg.ollama.host).preflight(cfg.ollama.model);
        if (!pf.ok) {
          tray.setWarning('ollama', `Ollama: ${pf.reason === 'unreachable' ? 'not running' : 'model missing'}`);
          if (notifyOnFailure) {
            localLogger.warn({ preflight: pf }, 'Ollama pre-flight failed');
            notify({ title: 'distill — Ollama check failed', body: preflightMessage(pf) });
          }
          return false;
        }
        localLogger.info({ model: pf.model }, 'Ollama pre-flight ok');
        tray.setWarning('ollama', null);
        return true;
      } catch (e) {
        localLogger.warn({ err: String(e) }, 'Ollama pre-flight errored (non-fatal)');
        return false;
      }
    };
    if (!(await checkOllama(true))) {
      const recheck = setInterval(() => {
        void checkOllama(false).then((ok) => {
          if (ok) clearInterval(recheck);
        });
      }, 120_000);
    }

    plaudStore = new KeychainCredentialStore();
    // Reading the Plaud password from the Keychain blocks while macOS shows
    // its "distill wants to use your confidential information" prompt —
    // which a new build's signature triggers again. Unanswered (overnight,
    // say), it held up startup and therefore polling for hours. Wait a
    // little, then carry on and connect as soon as the prompt is answered.
    const primed = plaudStore.prime().then(
      () => true,
      (e) => {
        localLogger.warn({ err: String(e) }, 'Keychain read failed; Plaud may need signing in again');
        return true;
      },
    );
    const primedInTime = await Promise.race([
      primed,
      new Promise<false>((resolve) => setTimeout(() => resolve(false), KEYCHAIN_WAIT_MS)),
    ]);
    if (!primedInTime) {
      localLogger.warn('waiting for Keychain access to the Plaud password; polling starts once it is approved');
      tray.setWarning('plaud', 'Plaud: waiting for Keychain access — approve the macOS prompt');
      notify({
        title: 'distill — Keychain access needed',
        body: 'Approve the macOS Keychain prompt so distill can check Plaud for new recordings.',
      });
      void primed.then(async () => {
        localLogger.info('Keychain access granted; connecting to Plaud');
        tray.setWarning('plaud', null);
        await migratePlaudPassword();
        await connectPlaudAndStartPipeline();
      });
    }
    if (primedInTime) {
      await migratePlaudPassword();
      await connectPlaudAndStartPipeline();
    }

    // Check Plaud as soon as the Mac wakes, rather than waiting out the
    // rest of the interval; the delay lets the network come back first.
    powerMonitor.on('resume', () => {
      setTimeout(() => {
        if (!poller) return;
        localLogger.info('Mac woke; checking Plaud for new recordings');
        void poller.syncNow();
      }, 15_000);
    });

    localLogger.info(
      {
        inbox: localState.inboxCount(),
        errors: localState.errorCount(),
        clients: localState.listClients().length,
        meetingTypes: localState.listMeetingTypes().length,
      },
      'distill ready',
    );

    stopAudioSweep = startSweepSchedule({
      state: sweepStateFor(localState),
      getRetentionDays: () => cfg.audioRetentionDays,
      fs: nodeFs,
      logger: localLogger,
    });

    // Weekly check for a newer generation of the summarisation model
    // (qwen3.6 → qwen3.7 → qwen4 …). Suggestion-only: it notifies and
    // surfaces a banner in Settings → Performance; the user decides
    // whether to download.
    stopModelCheck = startModelUpdateCheck({
      state: localState,
      logger: localLogger,
      getCurrentModel: () => cfg.ollama.model,
      onSuggestion: (s) => {
        notify({
          title: 'distill — newer model available',
          body: `${s.newFamily} has been released — a newer generation of your summarisation model (${s.currentModel}). Tap to review in Settings.`,
          onClick: () => openSettings({ initialTab: 'performance' }),
        });
      },
    });

    appReady = true;
    if (pendingFileDrops.length > 0) {
      localLogger.info({ count: pendingFileDrops.length }, 'processing deferred file drops');
      const deferred = pendingFileDrops.splice(0, pendingFileDrops.length);
      for (const p of deferred) {
        void handleFileDrop(p);
      }
    }
  }
});

app.on('before-quit', (e) => {
  // Don't lose a call in progress: stop, mix and import it, then quit again.
  if (recorder?.startedAt() != null) {
    e.preventDefault();
    // Bounded: a stuck ffmpeg must not make the app unquittable. If we give
    // up, the raw tracks stay in capture/ and are imported on next launch.
    const giveUp = new Promise<void>((resolve) => setTimeout(resolve, 90_000));
    void Promise.race([recorder.stop().catch(() => {}), giveUp]).finally(() => app.quit());
    return;
  }
  closeAll();
  worker?.stop();
  poller?.stop();
  stopAudioSweep?.();
  stopModelCheck?.();
  callWatch?.stop();
  trayHandle?.destroy();
  state?.close();
});

// Menu bar app: windows closing never quits the app.
app.on('window-all-closed', () => {});

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '?';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, '0')}s`;
  return `${r}s`;
}
