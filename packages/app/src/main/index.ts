import path from 'node:path';
import { app, dialog, shell } from 'electron';
import { appSupportDir, userVocabularyDir, expandHome } from './paths.js';
import { bundledResourcesDir } from './bundledResources.js';
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
  openSetup,
  closeAll,
} from './windows.js';
import {
  registerIpcHandlers,
  broadcastInboxChanged,
  broadcastFocusRecording,
} from './ipc.js';
import { getInstallationStatus } from './pythonEnv.js';
import { importLocalFile, LocalImportError } from './localImport.js';
import { migrateScopeRenames, migrateVocabularyToUserDir } from './vocabulary.js';
import { startSweepSchedule, sweepStateFor, nodeFs } from './audioRetention.js';

app.dock?.hide();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let trayHandle: TrayHandle | null = null;
let state: State | null = null;
let poller: Poller | null = null;
let worker: Worker | null = null;
let logger: Logger | null = null;
let stopAudioSweep: (() => void) | null = null;
let plaudStore: KeychainCredentialStore | null = null;

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
  localLogger.info({ cfg }, 'distill starting');

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
    applyConfigUpdate,
    // Lazy getter — the worker is constructed after Plaud connects, below.
    // Any IPC that fires before then will get null, which the pipeline
    // handlers tolerate (nudge and cancel are no-ops without a worker).
    getWorker: () => worker,
    // Plaud credential store is constructed later in this whenReady
    // block, so use a getter so the IPC handlers see it once it exists.
    getPlaudStore: () => plaudStore,
    onPlaudCredentialsChanged: () => {
      notify({
        title: 'distill — restart to apply',
        body: 'Restart distill to start syncing with the new Plaud account.',
      });
    },
    onStateChanged: () => trayHandle?.refresh(),
    onSetupComplete: () => {
      void continueBootstrap();
    },
  });

  const devVenvPath = path.join(app.getAppPath(), 'python', '.venv', 'bin', 'python');
  const installStatus = getInstallationStatus(devVenvPath);
  localLogger.info(
    {
      kind: installStatus.kind,
      pythonPath: installStatus.kind === 'ready' ? installStatus.pythonPath : null,
      source: installStatus.kind === 'ready' ? installStatus.source : undefined,
    },
    'python install status',
  );
  if (installStatus.kind === 'ready') {
    await continueBootstrap();
  } else {
    localLogger.info({ reason: installStatus.kind }, 'opening setup window');
    openSetup();
    return;
  }

  async function continueBootstrap(): Promise<void> {
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
      onOpenSettings: () => openSettings(),
      onPauseChange: (nextPause) => {
        const updated = applyConfigUpdate({ paused: nextPause });
        saveConfig(updated);
        trayHandle?.refresh();
        worker?.nudge();
        localLogger.info({ paused: nextPause }, 'pause settings changed');
      },
    });
    trayHandle = tray;

    const ollama = new OllamaClient(cfg.ollama.host);
    try {
      const pf = await ollama.preflight(cfg.ollama.model);
      if (!pf.ok) {
        const msg = preflightMessage(pf);
        localLogger.warn({ preflight: pf }, 'Ollama pre-flight failed');
        tray.setOllamaWarning(`Ollama: ${pf.reason === 'unreachable' ? 'not running' : 'model missing'}`);
        notify({ title: 'distill — Ollama check failed', body: msg });
      } else {
        localLogger.info({ model: pf.model }, 'Ollama pre-flight ok');
        tray.setOllamaWarning(null);
      }
    } catch (e) {
      localLogger.warn({ err: String(e) }, 'Ollama pre-flight errored (non-fatal)');
    }

    plaudStore = new KeychainCredentialStore();
    await plaudStore.prime();
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
          ollama,
          plaud: conn.client,
          packageDir: app.getAppPath(),
          // Used by prettifyError for path-aware messages (EACCES,
          // mlx_whisper missing). Both come from electron / paths
          // so they're set here rather than imported in errorMessages
          // (which keeps that module test-runnable in plain Node).
          appSupportDir: appSupportDirPath,
          isPackaged: app.isPackaged,
        },
        {
          onStateChanged: () => {
            trayHandle?.refresh();
            broadcastInboxChanged();
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
      worker.recoverOnStartup();

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
    } catch (e) {
      if (e instanceof PlaudNotAuthenticatedError) {
        localLogger.error({ err: e.message }, 'Plaud not authenticated');
        notify({
          title: 'distill — sign in needed',
          body: 'Open Settings -> Sources to sign in to Plaud.',
        });
        tray.setOllamaWarning('Plaud: not signed in');
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        localLogger.error({ err: msg }, 'failed to start Plaud poller');
        tray.setOllamaWarning(`Plaud: ${msg}`);
      }
    }

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

app.on('before-quit', () => {
  closeAll();
  worker?.stop();
  poller?.stop();
  stopAudioSweep?.();
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
