/**
 * Tray icon + menu.
 *
 * The tray icon is always a small microphone shape — preserving the
 * distill visual identity at a glance — but its colour reflects the
 * current pipeline state:
 *
 *   - idle        → template (auto-inverts for light/dark menu bars)
 *   - processing  → green   (#22c55e)
 *   - paused      → amber   (#f59e0b) — triggers on cfg.paused
 *   - error       → red     (#ef4444) — triggers on errorCount > 0 when
 *                                       nothing is actively processing
 *
 * Priority order: processing > paused > error > idle. The rationale is
 * that the tray colour should reflect what's happening now; persistent
 * warnings like "one recording errored earlier" stay visible in the ⚠
 * badge in the title text regardless of icon colour.
 */

import { Menu, Tray, nativeImage, app, shell } from 'electron';
import type { Logger } from 'pino';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type { ProcessingSummary, State } from './state.js';
import type { PollResult } from './poller.js';
import { logsDir } from './paths.js';
import { computeTrayState, type TrayState } from './trayState.js';
import { TIP_JAR_URL } from './tipJar.js';
import {
  formatPauseStatus,
  PAUSABLE_STEPS,
  pausedSteps,
  type PauseConfig,
  type PausableStep,
} from './pause.js';

export interface TrayContext {
  state: State;
  logger: Logger;
  resourcesDir: string;
  /** Live reference to the AppConfig so the tray can read cfg.paused. */
  getConfig: () => AppConfig;
  /** Trigger a manual poll when the user clicks "Sync now". */
  onSyncNow: () => void | Promise<void>;
  /** Open the inbox window, anchored below the tray. */
  onOpenInbox: (trayBounds: Electron.Rectangle) => void;
  /** Open the Settings window. */
  onOpenSettings: () => void;
  /**
   * Persist a new pause config to disk + live config. Called by the
   * Pause submenu items. The caller is responsible for re-running
   * any side effects (typically: tray.refresh + worker.nudge so
   * un-pausing immediately resumes work).
   */
  onPauseChange: (next: PauseConfig) => void;
}

export interface TrayHandle {
  /** Rebuild the menu to reflect current state (inbox count, last poll, etc). */
  refresh: () => void;
  /** Note the latest poll result so the status line can show it. */
  setLastPoll: (result: PollResult | null) => void;
  /** Note the latest Ollama pre-flight outcome (null = not checked yet). */
  setOllamaWarning: (message: string | null) => void;
  destroy: () => void;
}

export function createTray(ctx: TrayContext): TrayHandle {
  // Icon cache so we're not re-parsing SVG on every rebuild. Keyed by
  // state; each entry is built lazily the first time that state occurs.
  const iconCache = new Map<TrayState, Electron.NativeImage>();
  const iconFor = (s: TrayState): Electron.NativeImage => {
    const cached = iconCache.get(s);
    if (cached) return cached;
    const built = loadTrayIcon(ctx.resourcesDir, s, ctx.logger);
    iconCache.set(s, built);
    return built;
  };

  const tray = new Tray(iconFor('idle'));
  tray.setToolTip('distill');

  let lastPoll: PollResult | null = null;
  let ollamaWarning: string | null = null;
  let currentState: TrayState = 'idle';

  const rebuild = (): void => {
    const inbox = ctx.state.inboxCount();
    const errors = ctx.state.errorCount();
    const processing = ctx.state.processingSummary();
    const cfg = ctx.getConfig();

    // Update icon colour if the state has changed. Redundant setImage
    // calls cost nothing functionally, but skipping them keeps the
    // taskbar from flickering on rapid rebuilds during pipeline runs.
    //
    // Pause for icon purposes is "is anything paused at all" - the
    // amber icon means "I'm not in my normal idle/working state". The
    // submenu and status line distinguish master vs per-step.
    const anyPaused = cfg.paused.all || pausedSteps(cfg.paused).length > 0;
    const nextState = computeTrayState({
      processingRunning: processing.running > 0,
      paused: anyPaused,
      errorCount: errors,
    });
    if (nextState !== currentState) {
      tray.setImage(iconFor(nextState));
      currentState = nextState;
    }

    // Menu bar title. Counts and the warning glyph still show regardless
    // of icon colour — colour is the "now state", title text is the
    // "persistent stats". The • is dropped here because the colour already
    // communicates "processing" more clearly than a dot ever did.
    let title = '';
    if (inbox > 0) title += ` ${inbox}`;
    if (errors > 0) title += ` ⚠`;
    tray.setTitle(title);

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: statusLine(inbox, errors, lastPoll, processing, cfg.paused), enabled: false },
    ];

    if (ollamaWarning) {
      template.push({ type: 'separator' });
      template.push({ label: ollamaWarning, enabled: false });
    }

    template.push(
      { type: 'separator' },
      {
        label: `Inbox${inbox > 0 ? ` (${inbox})` : ''}…`,
        click: () => ctx.onOpenInbox(tray.getBounds()),
      },
      { type: 'separator' },
      {
        label: 'Sync now',
        click: () => {
          void ctx.onSyncNow();
        },
      },
      buildPauseSubmenu(cfg.paused, ctx.onPauseChange),
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => ctx.onOpenSettings(),
      },
      {
        label: 'Open logs folder',
        click: () => {
          shell.openPath(logsDir()).catch((e) =>
            ctx.logger.warn({ err: String(e) }, 'failed to open logs folder'),
          );
        },
      },
      {
        label: 'Open config folder',
        click: () => {
          shell.openPath(join(app.getPath('home'), 'Library', 'Application Support', 'distill'))
            .catch((e) => ctx.logger.warn({ err: String(e) }, 'failed to open config folder'));
        },
      },
      { type: 'separator' },
      // Tip-jar entry. Always visible; the user can click it any time
      // they fancy supporting development without waiting for the
      // 50-summary banner. Routed through shell.openExternal directly
      // here rather than via IPC because the tray runs in main and
      // there's no renderer to notify.
      {
        label: 'Buy me a coffee…',
        click: () => {
          shell
            .openExternal(TIP_JAR_URL)
            .catch((e) =>
              ctx.logger.warn(
                { err: String(e), url: TIP_JAR_URL },
                'failed to open tip-jar URL from tray menu',
              ),
            );
        },
      },
      { type: 'separator' },
      { label: 'Quit distill', role: 'quit' },
    );

    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  rebuild();

  return {
    refresh: rebuild,
    setLastPoll: (r) => {
      lastPoll = r;
      rebuild();
    },
    setOllamaWarning: (m) => {
      ollamaWarning = m;
      rebuild();
    },
    destroy: () => tray.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Status line + processing label (formerly at the bottom of the file)
// ---------------------------------------------------------------------------

function statusLine(
  inbox: number,
  errors: number,
  last: PollResult | null,
  processing: ProcessingSummary,
  paused: PauseConfig,
): string {
  const bits: string[] = [];

  // Priority of first segment (mirrors the icon's priority, one level
  // lower because the menu is for detail not glance-ability):
  //   processing > paused > last sync status.
  //
  // formatPauseStatus returns null when nothing is paused. When
  // anything is paused, it returns either "Paused" (master switch)
  // or "Paused (downloads, transcribe)" (per-step). The former wins
  // over a stale last-sync result; the latter is more useful than
  // "Synced 3m ago" when the user has just paused something.
  const pauseLabel = formatPauseStatus(paused);
  if (processing.currentStatus) {
    bits.push(humanProcessingLabel(processing.currentStatus));
  } else if (pauseLabel) {
    bits.push(pauseLabel);
  } else if (!last) {
    bits.push('Starting…');
  } else if (last.kind === 'ok') {
    bits.push(`Synced ${formatRelative(last.at)}`);
  } else if (last.kind === 'skipped-paused') {
    // Defensive: poller emits this when shouldPause() returns true.
    // We've already covered that case via pauseLabel above, so this
    // is only reachable on a transient mismatch (poll fired before
    // applyConfigUpdate landed). Show the generic label.
    bits.push('Paused');
  } else {
    bits.push(`Sync failed ${formatRelative(last.at)}`);
  }

  // Queue depth only matters while the pipeline is running; omit otherwise.
  if (processing.queued > 0) {
    bits.push(`${processing.queued} queued`);
  }

  if (inbox > 0) bits.push(`${inbox} in inbox`);
  if (errors > 0) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/**
 * Build the "Pause" submenu. Layout (matches BACKLOG):
 *
 *   Pause >
 *     [✓] All processing
 *     -----
 *     [✓] Polling
 *     [✓] Downloads
 *     [✓] Transcription
 *     [✓] Summarisation
 *
 * Visual rules when master "All processing" is on:
 *   - Per-step items are disabled (greyed) and shown unchecked.
 *     Their stored values are preserved so flipping master off
 *     restores the user's per-step preferences. The visual unchecked
 *     state telegraphs "these don't matter right now".
 *
 * Click handlers compute the next PauseConfig and hand it to
 * `onPauseChange`. The host (index.ts) is responsible for persisting
 * + nudging the worker.
 */
function buildPauseSubmenu(
  paused: PauseConfig,
  onPauseChange: (next: PauseConfig) => void,
): Electron.MenuItemConstructorOptions {
  const stepLabels: Record<PausableStep, string> = {
    polling: 'Polling',
    download: 'Downloads',
    transcribe: 'Transcription',
    summarise: 'Summarisation',
  };

  const submenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'All processing',
      type: 'checkbox',
      checked: paused.all,
      click: () => onPauseChange({ ...paused, all: !paused.all }),
    },
    { type: 'separator' },
    ...PAUSABLE_STEPS.map<Electron.MenuItemConstructorOptions>((step) => ({
      label: stepLabels[step],
      type: 'checkbox',
      // When master is on, show per-step items as unchecked + disabled.
      // Their stored values are preserved so flipping master off restores
      // them; we just don't expose that visually because it would imply
      // they have effect right now.
      checked: paused.all ? false : paused[step],
      enabled: !paused.all,
      click: () => onPauseChange({ ...paused, [step]: !paused[step] }),
    })),
  ];

  return {
    label: 'Pause',
    submenu,
  };
}

function humanProcessingLabel(
  s: NonNullable<ProcessingSummary['currentStatus']>,
): string {
  switch (s) {
    case 'downloading':
      return 'Downloading…';
    case 'transcribing':
      return 'Transcribing…';
    case 'summarising':
      return 'Summarising…';
    case 'writing':
      return 'Writing…';
  }
}

function formatRelative(epochMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

/**
 * Colours chosen to match the macOS system palette roughly — green/amber/red
 * on medium saturation read well on both light and dark menu bars without
 * an outline. Slightly muted vs. full-bright to avoid looking alarming.
 */
const STATE_COLOUR: Record<Exclude<TrayState, 'idle'>, string> = {
  processing: '#22c55e', // green-500
  paused: '#f59e0b',     // amber-500
  error: '#ef4444',      // red-500
};

/**
 * Load the tray icon for the given state.
 *
 * Strategy (in order):
 *   1. PNG file in resources/icons/ — the reliable path. Electron's
 *      nativeImage.createFromPath picks up @2x siblings automatically
 *      for Retina.
 *   2. Inline SVG fallback — used if PNGs haven't been generated yet.
 *      Known to produce empty NativeImages on some Electron/macOS
 *      combos (notably Electron 33 + Apple Silicon), hence the PNG
 *      primary. If this ever fires, logs tell the user exactly what
 *      to run.
 *   3. Empty image — last resort, tray still functions via title text.
 *
 * PNG filenames match the Python generator's output:
 *   trayTemplate.png   — idle (template, macOS auto-inverts)
 *   trayProcessing.png — green
 *   trayPaused.png     — amber
 *   trayError.png      — red
 */
function loadTrayIcon(
  resourcesDir: string,
  state: TrayState,
  logger?: Logger,
): Electron.NativeImage {
  const filename = PNG_FILENAME[state];
  const iconPath = join(resourcesDir, 'icons', filename);
  const fromFile = nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) {
    // Only the idle icon is a template image. Coloured variants
    // are left as-is so macOS doesn't monochrome them.
    if (state === 'idle') fromFile.setTemplateImage(true);
    return fromFile;
  }

  // PNG missing — fall back to SVG (likely empty on Electron 33) and
  // log a clear hint.
  logger?.warn(
    { state, iconPath },
    `Tray icon PNG not found. Run: python3 scripts/generate-tray-icons.py (from packages/app) to generate all four state icons at 22px + @2x.`,
  );
  return renderMicrophoneIconSvg(state, logger);
}

const PNG_FILENAME: Record<TrayState, string> = {
  idle: 'trayTemplate.png',
  processing: 'trayProcessing.png',
  paused: 'trayPaused.png',
  error: 'trayError.png',
};

/**
 * SVG fallback renderer — kept as a last-ditch in case PNGs are missing.
 * Known to produce empty NativeImages on Electron 33 + Apple Silicon,
 * which is exactly why we added the PNG path above. Retained rather
 * than deleted so the app still functions (coloured state via title
 * text only) on systems where PNGs haven't been generated yet.
 */
function renderMicrophoneIconSvg(
  state: TrayState,
  logger?: Logger,
): Electron.NativeImage {
  const isTemplate = state === 'idle';
  const fill = isTemplate ? 'black' : STATE_COLOUR[state];

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5" y="1.5" width="6" height="9" rx="3" fill="${fill}"/><path d="M3 7.5 v1 a5 5 0 0 0 10 0 v-1" stroke="${fill}" stroke-width="1.5" fill="none" stroke-linecap="round"/><rect x="7" y="13" width="2" height="2" fill="${fill}"/></svg>`;

  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) {
    logger?.warn(
      { state, svgLen: svg.length },
      'tray icon: SVG fallback also produced an empty NativeImage. Run the Python generator to produce PNG files (see previous warning).',
    );
    return nativeImage.createEmpty();
  }
  img.setTemplateImage(isTemplate);
  return img;
}
