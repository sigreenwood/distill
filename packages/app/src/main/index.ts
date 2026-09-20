/**
 * Entry point — Electron main process.
 *
 * Milestone 2 responsibilities (cumulative with M0 + M1):
 *   1. Load config; exit cleanly with a dialog if missing.
 *   2. Open SQLite, run migrations.
 *   3. Seed clients + meeting types (idempotent).
 *   4. Show the tray icon, with "Inbox…" wired to open the inbox window.
 *   5. Run an Ollama pre-flight and surface any warning in the tray.
 *   6. Connect to @plaud/core and start the poller; notify on new recordings.
 *   7. Construct the pipeline Worker, recover any interrupted rows, and
 *      wire cancellation + retry IPC through it.
 *   8. Notify the user when a summary is ready, with click-to-reveal.
 */

import { app, dialog, shell } from 'electron';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { createLogger } from './logger.js';
import { ConfigMissingError, loadConfig, normaliseConfig, saveConfig, type AppConfig } from './config.js';
import { openDatabase, State } from './state.js';
import { seedIfEmpty } from './seed.js';
import { createTray, type TrayHandle } from './tray.js';
import { OllamaClient, preflightMessage } from './ollama.js';
import { connect, PlaudNotAuthenticatedError } from './plaud.js';
import { KeychainCredentialStore, migratePasswordToKeychain } from './sources/keychainCredentialStore.js';
import { Poller, type PollResult } from './poller.js';
import { loadProcessedElsewhereIds } from './processedElsewhere.js';
import { expandHome } from './paths.js';
import { appSupportDir } from './paths.js';
import { notify } from './notifications.js';
import {
  broadcastFocusRecording,
  broadcastInboxChanged,
  registerIpcHandlers,
} from './ipc.js';
import { closeAll, configureWindows, openInbox, openSettings, openSetup } from './windows.js';
import { Worker } from './pipeline/worker.js';
import { importLocalFile, LocalImportError } from './localImport.js';
import { nodeFs, startSweepSchedule, sweepStateFor } from './audioRetention.js';
import { bundledResourcesDir } from './bundledResources.js';
import { getInstallationStatus } from './pythonSetup.js';
import { migrateVocabularyToUserDir, migrateScopeRenames } from './vocabulary.js';
import { userVocabularyDir } from './paths.js';
import { recordCompletion as recordTipJarCompletion, TIP_JAR_URL } from './tipJar.js';

// Keep distill visible in the macOS Dock as well as the menu bar.
app.dock?.show();

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

// ---------------------------------------------------------------------------
// File-drop handling (Dock drops, Finder "Open With…")
//
// macOS fires `open-file` on the Electron `app` whenever a user drops a file
// onto the app icon in the Dock, uses "Open with … distill", or (if we
// ever register file associations) double-clicks a recognised file.
//
// This can fire BEFORE `app.whenReady()` resolves. We queue any early drops
// in `pendingFileDrops` and drain them once state + logger are ready.
// ---------------------------------------------------------------------------
const pendingFileDrops: string[] = [];
let appReady = false;

app.on('open-file', (event, path) => {
  event.preventDefault();
  if (appReady) {
    void handleFileDrop(path);
  } else {
    pendingFileDrops.push(path);
  }
});

async function handleFileDrop(path: string): Promise<void> {
  if (!state) return;
  // The logger is guaranteed to exist here because appReady is only set
  // after it's constructed; re-derive from the closure.
  const log = logger;
  try {
    const result = await importLocalFile(path, {
      state,
      logger: log ?? ({ info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger),
    });
    trayHandle?.refresh();
    broadcastInboxChanged();
    openInbox(undefined, result.recordingId);
    broadcastFocusRecording(result.recordingId);
  } catch (e) {
    const msg = e instanceof LocalImportError ? e.userMessage : `Import failed: ${String(e)}`;
    log?.warn({ err: String(e), path }, 'file drop import failed');
    dialog.showErrorBox('distill — import failed', msg);
  }
}

app.whenReady().then(async () => {
  // Where bundled resources live (vocabulary JSON, PROMPTS.md, tray
  // icons, the example config). Same in dev and packaged builds:
  // bundledResourcesDir() is `<packageDir>/resources` in dev and
  // `<process.resourcesPath>/resources` in a packaged .app, where
  // electron-builder's extraResources rule lands them.
  const resourcesDir = bundledResourcesDir();

  // Captured once for downstream use — same value as paths.appSupportDir()
  // but pulled into a local so we can pass it into Worker / IPC contexts
  // without each consumer re-importing electron's app module.
  const appSupportDirPath = appSupportDir();

  // First-launch vocabulary migration. Copies bundled placeholder
  // files (or the contributor's real dev-tree files) into the user-writable
  // appSupportDir/vocabulary/ if they're not already there. After
  // this, all vocabulary reads (pipeline) and writes (Settings)
  // hit the user dir, never the .app bundle. Idempotent: safe to
  // run on every launch.
  //
  // Has to happen BEFORE seedIfEmpty so the pipeline's first
  // transcription has a populated vocab dir to read from. We don't
  // have a logger yet at this point, so the migration logs to the
  // bootstrap console; failures don't block startup (the pipeline
  // tolerates missing vocab files).
  //
  // The rename migration runs FIRST so any pre-rename teradata.json
  // and ai.json get renamed to organisation.json / industry.json
  // before the second migration looks at what's already there.
  // Otherwise migrateVocabularyToUserDir would copy fresh empty
  // organisation.json / industry.json files alongside the user's
  // populated teradata.json / ai.json, leaving them with both old
  // (populated, unread) and new (empty, read) files — confusing
  // and silently lossy.
  try {
    migrateScopeRenames(userVocabularyDir());
    migrateVocabularyToUserDir(
      join(bundledResourcesDir(), 'vocabulary'),
      userVocabularyDir(),
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('vocabulary migration threw:', e);
  }

  let cfg: AppConfig;
  try {
    cfg = loadConfig(resourcesDir);
  } catch (e) {
    if (e instanceof ConfigMissingError) {
      // Reaches here only when the bundled example.config.json is
      // also missing — i.e. the install is broken, not a normal
      // first run. Fresh installs are auto-bootstrapped by
      // loadConfig from the bundled example, then land directly in
      // the app and sign in via Settings → Sources.
      dialog.showErrorBox(
        'distill — install looks broken',
        `No config file at ${e.expectedPath}, and no bundled example to ` +
          `bootstrap from. The app install may be incomplete. Try ` +
          `reinstalling distill, or place a config.json at the path above.`,
      );
      app.quit();
      return;
    }
    throw e;
  }

  const localLogger = createLogger({ level: cfg.logLevel, pretty: !app.isPackaged });
  logger = localLogger;
  localLogger.info({ cfg }, 'distill starting');

  // ---------------------------------------------------------------------------
  // SQLite + seed
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // Window manager + IPC
  // ---------------------------------------------------------------------------
  configureWindows({
    preloadPath: join(app.getAppPath(), 'out', 'preload', 'index.js'),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    rendererDistDir: join(app.getAppPath(), 'out', 'renderer'),
  });

  // Lifted out of `registerIpcHandlers` so the tray (and any future
  // non-IPC caller) can apply the same merge-and-renormalise as the
  // Settings UI does. Returns the new live config so callers that need
  // to immediately persist (saveConfig) can do so without re-reading.
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
      // Sign-in / sign-out via the UI persists credentials immediately
      // but the running poller and pipeline worker were constructed
      // against whatever connection state existed at startup. Rebuilding
      // them safely (handle in-flight work, swap clients atomically)
      // is more invasive than this session's scope. For now, surface a
      // clear "restart required" notification — the user signs in,
      // sees the success state, and is told what to do next. A future
      // BACKLOG item upgrades this to live re-connect.
      notify({
        title: 'distill — restart to apply',
        body: 'Restart distill to start syncing with the new Plaud account.',
      });
    },
    onStateChanged: () => trayHandle?.refresh(),
    onSetupComplete: () => {
      // First-launch venv install just finished. Continue building the
      // rest of the app (tray, Plaud, worker, poller, audio sweep).
      // The setup window auto-closes on its own from the renderer
      // side after showing a brief success message.
      void continueBootstrap();
    },
  });

  // ---------------------------------------------------------------------------
  // Python setup gate
  //
  // distill ships without a Python venv (~840MB symlinks aren't viable
  // to bundle). Each user gets one created on first launch via the
  // setup window. A contributor running `npm run dev` from a checked-out
  // repo will already have a venv at packages/app/python/.venv, which
  // counts as 'ready' so dev mode doesn't go through setup.
  //
  // If the venv is ready, we proceed straight to continueBootstrap.
  // Otherwise we open the setup window and wait for it to either
  // install the venv (onSetupComplete fires) or the user quits.
  // ---------------------------------------------------------------------------
  const devVenvPath = join(
    app.getAppPath(),
    'python',
    '.venv',
    'bin',
    'python',
  );
  const installStatus = getInstallationStatus(devVenvPath);
  localLogger.info(
    {
      kind: installStatus.kind,
      pythonPath:
        installStatus.kind === 'ready' ? installStatus.pythonPath : null,
      source:
        installStatus.kind === 'ready' ? installStatus.source : undefined,
    },
    'python install status',
  );

  if (installStatus.kind === 'ready') {
    await continueBootstrap();
  } else {
    // Open the setup window. The setup IPC handlers (registered
    // above) drive the install; onSetupComplete continues bootstrap
    // when it succeeds. If the user quits, app.quit() runs and the
    // before-quit handler tears down what little we've built.
    localLogger.info(
      { reason: installStatus.kind },
      'opening setup window',
    );
    openSetup();
    // Don't fall through — continueBootstrap runs only after setup
    // succeeds.
    return;
  }

  // ---------------------------------------------------------------------------
  // continueBootstrap: everything past the Python-setup gate.
  //
  // Closes over `cfg`, `localState`, `localLogger`, etc. so it can be
  // invoked either inline (when the venv is already ready) or later
  // from the onSetupComplete callback (when first-launch setup just
  // finished).
  //
  // Marked async because the Plaud connect path is async and we want
  // to keep the await semantics. Any throw lands in whoever invoked
  // us, which is either the top-level whenReady handler (await-ed) or
  // the onSetupComplete callback (void-discarded; we log there).
  // ---------------------------------------------------------------------------
  async function continueBootstrap(): Promise<void> {
  // ---------------------------------------------------------------------------
  // Tray
  // ---------------------------------------------------------------------------
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
      // Persist the new pause shape via the same applyConfigUpdate path
      // the Settings UI uses, then refresh and nudge. Nudging matters
      // for the un-pause case: if the worker had nothing to do because
      // every claimable row's next step was paused, it'll have exited
      // its loop and won't restart on its own without a nudge.
      const updated = applyConfigUpdate({ paused: nextPause });
      saveConfig(updated);
      trayHandle?.refresh();
      worker?.nudge();
      localLogger.info({ paused: nextPause }, 'pause settings changed');
    },
  });
  trayHandle = tray;

  // ---------------------------------------------------------------------------
  // Ollama client (shared between pre-flight and pipeline)
  // ---------------------------------------------------------------------------
  const ollama = new OllamaClient(cfg.ollama.host);
  try {
    const pf = await ollama.preflight(cfg.ollama.model);
    if (!pf.ok) {
      const msg = preflightMessage(pf);
      localLogger.warn({ preflight: pf }, 'Ollama pre-flight failed');
      tray.setOllamaWarning(
        `Ollama: ${pf.reason === 'unreachable' ? 'not running' : 'model missing'}`,
      );
      notify({ title: 'distill — Ollama check failed', body: msg });
    } else {
      localLogger.info({ model: pf.model }, 'Ollama pre-flight ok');
      tray.setOllamaWarning(null);
    }
  } catch (e) {
    localLogger.warn({ err: String(e) }, 'Ollama pre-flight errored (non-fatal)');
  }

  // ---------------------------------------------------------------------------
  // Plaud credential store (Keychain-backed)
  // ---------------------------------------------------------------------------
  // Constructed and primed before the connect() call below, since
  // PlaudAuth.login() reads credentials synchronously through the
  // CredentialStore interface. prime() warms the in-memory password
  // cache from Keychain (or the legacy file location during migration).
  plaudStore = new KeychainCredentialStore();
  await plaudStore.prime();

  // One-time password migration. If the password still lives in
  // ~/.plaud/config.json (legacy state) AND a copy is now in Keychain,
  // remove it from the file so Keychain becomes the only source.
  // Idempotent and safe to run on every launch.
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

  // ---------------------------------------------------------------------------
  // Plaud connection + poller + pipeline worker
  // ---------------------------------------------------------------------------
  try {
    const conn = connect(plaudStore);
    localLogger.info({ region: conn.region }, 'Plaud connection ready');

    // Pipeline worker — constructed now that we have a Plaud client.
    // The worker operates independently of the poller: it processes any
    // 'tagged' recording it finds, regardless of how that tag was set.
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

          // Tip-jar bookkeeping. Increments a per-install counter and
          // — exactly once — fires a friendly tray notification when
          // the user crosses the threshold. The notification is a
          // separate macOS banner from the "Summary ready" one above
          // because the two messages have different intents (here's
          // your work / nice work, want to support development?). The
          // user can click through to the tip jar from the
          // notification or ignore it; subsequent completions are
          // silent.
          //
          // Errors here are non-fatal — a failing setAppState would
          // be logged-and-skipped rather than rolling back the
          // pipeline complete (which has already happened). We don't
          // want a corrupt counter to block summaries from finishing.
          try {
            const outcome = recordTipJarCompletion(localState);
            if (outcome.kind === 'threshold-just-hit') {
              localLogger.info(
                { count: outcome.count },
                'tip-jar threshold reached — firing one-shot notification',
              );
              notify({
                title: `${outcome.count} summaries done — nice work`,
                body:
                  'Glad distill is earning its keep. If you\'d like to ' +
                  'support development, you can keep me caffeinated. ' +
                  'Tap to open the tip jar.',
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
            localLogger.warn(
              { err: String(e), id },
              'tip-jar bookkeeping failed (non-fatal)',
            );
          }
        },
      },
    );

    // Recover any row that was mid-pipeline when the app last exited.
    // recoverOnStartup reverts in-flight statuses to 'tagged' and then
    // nudges the worker; per-step output checks mean no redundant work.
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
      // back to single-machine semantics. See processedElsewhere.ts
      // for the design.
      loadProcessedElsewhere: async () => {
        if (!cfg.outputs.markdown.enabled) return new Map();
        const dir = expandHome(cfg.outputs.markdown.dir);
        return loadProcessedElsewhereIds(dir);
      },
      onPoll: (result: PollResult, fresh) => {
        tray.setLastPoll(result);
        tray.refresh();

        if (result.kind === 'ok' && fresh.length > 0) {
          for (const r of fresh) {
            // r.duration is milliseconds from Plaud; formatDuration wants
            // seconds. Same conversion the poller does before storing.
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

  // Audio retention: locally-imported audio gets pruned `audioRetentionDays`
  // after the most recent successful output write. Plaud-sourced audio is
  // left alone (re-fetchable from the cloud). The first sweep runs now;
  // subsequent sweeps run every 24 hours via the returned interval.
  // Reads `audioRetentionDays` via the live config getter so a Settings
  // change between sweeps is honoured without restart.
  stopAudioSweep = startSweepSchedule({
    state: sweepStateFor(localState),
    getRetentionDays: () => cfg.audioRetentionDays,
    fs: nodeFs,
    logger: localLogger,
  });

  // Drain any file drops that arrived during startup.
  appReady = true;
  if (pendingFileDrops.length > 0) {
    localLogger.info({ count: pendingFileDrops.length }, 'processing deferred file drops');
    const deferred = pendingFileDrops.splice(0, pendingFileDrops.length);
    for (const path of deferred) {
      void handleFileDrop(path);
    }
  }
  } // end continueBootstrap
});

app.on('before-quit', () => {
  closeAll();
  worker?.stop();
  poller?.stop();
  stopAudioSweep?.();
  trayHandle?.destroy();
  state?.close();
});

// Electron normally quits when all windows close, but distill is a
// menu-bar app: the tray icon is the persistent UI. Suppress the default
// quit so the tray stays alive when the inbox window is dismissed.
// (The `before-quit` handler above runs on real quit via Cmd-Q / tray.)
app.on('window-all-closed', () => {
  // No-op: do nothing, which is the supported way to override the default
  // quit behaviour. Electron's listener type is zero-arg here; we keep it
  // empty to satisfy that signature.
});

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '?';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, '0')}s`;
  return `${r}s`;
}
