import path from 'node:path';
import { app, shell, powerMonitor, Menu, Tray, nativeImage, type NativeImage, type Rectangle } from 'electron';
import {
  PAUSABLE_STEPS,
  formatPauseStatus,
  pausedSteps,
  type AppConfig,
  type PauseConfig,
  type PausableStep,
} from './config.js';
import { evaluateSchedule } from './processingSchedule.js';
import { logsDir } from './paths.js';
import type { Logger } from './logger.js';
import type { ProcessingSummary, RecordingStatus, State } from './state.js';
import { TIP_JAR_URL } from './tipJar.js';

/**
 * 'active' collapses downloading/transcribing/summarising/writing into one
 * glyph — the Essence tray templates share a small activity dot for all
 * three (see resources/icons/EssenceActiveTemplate.png); the exact phase
 * is distinguished by the tooltip text instead (see humanProcessingLabel).
 */
export type TrayState = 'idle' | 'waiting' | 'active' | 'paused' | 'attention' | 'error';

/** No successful Plaud check for this long (while connected) turns the icon amber. */
export const STALE_POLL_MS = 30 * 60_000;

export type LastPollResult =
  | { kind: 'ok'; at: number }
  | { kind: 'error'; at: number }
  | { kind: 'skipped-paused'; at: number };

export interface TrayContext {
  state: State;
  logger: Logger;
  resourcesDir: string;
  getConfig: () => AppConfig;
  onOpenInbox: (trayBounds: Rectangle) => void;
  /** Open the inbox focused on the first errored recording. */
  onOpenErrors: (trayBounds: Rectangle) => void;
  /** Clear every errored recording (marks them skipped). */
  onDismissErrors?: () => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
  onOpenClientBrief: () => void;
  onOpenClientRegister: () => void;
  onSyncNow: () => Promise<void> | void;
  onPauseChange: (next: PauseConfig) => void;
}

export interface TrayHandle {
  refresh: () => void;
  setLastPoll: (r: LastPollResult) => void;
  /** Show (or clear, with null) a warning for one source; Plaud and Ollama warnings are independent. */
  setWarning: (source: 'plaud' | 'ollama', m: string | null) => void;
  destroy: () => void;
}

/**
 * Precedence: an actionable error always wins (it needs the user to do
 * something), then effective pause (nothing will move until unpaused),
 * then whatever is actually running, then "something's waiting for you
 * to tag it", then idle. There is no transient "just completed" tray
 * state — see HANDOFF.md for why that's deliberately out of scope here.
 */
export function computeTrayState(inputs: {
  processingRunning: boolean;
  paused: boolean;
  errorCount: number;
  waitingCount: number;
  /**
   * distill can't do its job without the user: not checking Plaud
   * (Keychain prompt waiting, signed out, connection failed, or no
   * successful check for STALE_POLL_MS) or Ollama unavailable. Shown in
   * amber; before this, these only appeared as a line inside the menu.
   */
  attention?: boolean;
}): TrayState {
  if (inputs.errorCount > 0) return 'error';
  if (inputs.attention) return 'attention';
  if (inputs.paused) return 'paused';
  if (inputs.processingRunning) return 'active';
  if (inputs.waitingCount > 0) return 'waiting';
  return 'idle';
}

export function createTray(ctx: TrayContext): TrayHandle {
  const iconCache = new Map<TrayState, NativeImage>();
  const iconFor = (s: TrayState): NativeImage => {
    const cached = iconCache.get(s);
    if (cached) return cached;
    const built = loadTrayIcon(ctx.resourcesDir, s, ctx.logger);
    iconCache.set(s, built);
    return built;
  };

  const tray = new Tray(iconFor('idle'));
  // A stall produces no event, so look again every minute.
  const staleTimer = setInterval(() => rebuild(), 60_000);
  tray.setToolTip('distill');

  let lastPoll: LastPollResult | null = null;
  const warnings: Record<'plaud' | 'ollama', string | null> = { plaud: null, ollama: null };
  let currentState: TrayState = 'idle';
  // Last successful Plaud check; null until the first one.
  let lastOkPollAt: number | null = null;
  const startedAt = Date.now();

  // Polling has been running but nothing has succeeded for a while: a
  // stall the app doesn't otherwise know about. Paused polling is not one.
  const staleReason = (): string | null => {
    const cfg = ctx.getConfig();
    if (cfg.paused.all || cfg.paused.polling || lastPoll === null) return null;
    const since = lastOkPollAt ?? startedAt;
    const minutes = Math.round((Date.now() - since) / 60_000);
    return Date.now() - since > STALE_POLL_MS ? `Plaud: no successful check for ${minutes} minutes` : null;
  };

  const rebuild = () => {
    const inbox = ctx.state.inboxCount();
    const errors = ctx.state.errorCount();
    const processing = ctx.state.processingSummary();
    const cfg = ctx.getConfig();
    const anyPaused = cfg.paused.all || pausedSteps(cfg.paused).length > 0;
    // Tagged rows waiting on an idle/overnight processingSchedule window
    // (see processingSchedule.ts) count as "waiting" too, same as an
    // untagged inbox item — otherwise queued-but-blocked work would show
    // as idle, the exact "looks fine, isn't" failure CLAUDE.md warns
    // about. An urgent row among them gets claimed by the worker almost
    // immediately, which naturally moves `running` above 0 and out of
    // this branch — no separate urgent check needed here.
    const schedule = evaluateSchedule(cfg.processingSchedule, powerMonitor.getSystemIdleTime());
    const scheduleBlocked = processing.queued > 0 && processing.running === 0 && !schedule.allowed;
    const nextState = computeTrayState({
      processingRunning: processing.running > 0,
      paused: anyPaused,
      errorCount: errors,
      waitingCount: inbox + (scheduleBlocked ? processing.queued : 0),
      attention: warnings.plaud !== null || warnings.ollama !== null || staleReason() !== null,
    });
    if (nextState !== currentState) {
      tray.setImage(iconFor(nextState));
      currentState = nextState;
    }
    // Tooltip updates every rebuild, not only on an icon change: the phase
    // behind a steady 'active' glyph (downloading -> transcribing -> ...)
    // still moves, and the tooltip is the only place that says which.
    const scheduleReason = scheduleBlocked ? schedule.reason : null;
    tray.setToolTip(`distill — ${trayTooltipLabel(nextState, processing, errors, scheduleReason)}`);
    let title = '';
    if (inbox > 0) title += ` ${inbox}`;
    if (errors > 0) title += ' ⚠';
    tray.setTitle(title);

    const template: Electron.MenuItemConstructorOptions[] = [
      { label: statusLine(inbox, errors, lastPoll, processing, cfg.paused, scheduleReason), enabled: false },
    ];
    const stale = staleReason();
    const lines = [warnings.plaud, warnings.ollama, stale].filter((l): l is string => l !== null);
    if (lines.length > 0) {
      template.push({ type: 'separator' });
      for (const label of lines) template.push({ label, enabled: false });
    }
    template.push(
      { type: 'separator' },
      {
        label: `Inbox${inbox > 0 ? ` (${inbox})` : ''}…`,
        click: () => ctx.onOpenInbox(tray.getBounds()),
      },
    );
    // The ⚠ in the menu bar has to lead somewhere. Without this the only
    // route to the rows that clear it was Inbox → scroll, and the icon
    // looked like it was stuck for good.
    if (errors > 0) {
      template.push({
        label: `Review ${errors} error${errors === 1 ? '' : 's'}…`,
        click: () => ctx.onOpenErrors(tray.getBounds()),
      });
      if (ctx.onDismissErrors) {
        template.push({
          label: `Dismiss ${errors === 1 ? 'this error' : 'all errors'}`,
          toolTip:
            'Marks the failed recordings as skipped and clears the warning. They can be re-tagged from Plaud later.',
          click: () => ctx.onDismissErrors?.(),
        });
      }
    }
    template.push(
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
        label: 'History…',
        click: () => ctx.onOpenHistory(),
      },
      {
        label: 'Client brief…',
        click: () => ctx.onOpenClientBrief(),
      },
      {
        label: 'Client register…',
        click: () => ctx.onOpenClientRegister(),
      },
      {
        label: 'Open logs folder',
        click: () => {
          shell
            .openPath(logsDir())
            .catch((e) => ctx.logger.warn({ err: String(e) }, 'failed to open logs folder'));
        },
      },
      {
        label: 'Open config folder',
        click: () => {
          shell
            .openPath(path.join(app.getPath('home'), 'Library', 'Application Support', 'distill'))
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
      if (r.kind === 'ok') lastOkPollAt = r.at;
      rebuild();
    },
    setWarning: (source, m) => {
      warnings[source] = m;
      rebuild();
    },
    destroy: () => {
      clearInterval(staleTimer);
      tray.destroy();
    },
  };
}

function trayTooltipLabel(
  state: TrayState,
  processing: ProcessingSummary,
  errors: number,
  scheduleReason: string | null,
): string {
  switch (state) {
    case 'error':
      return `Needs attention (${errors} error${errors === 1 ? '' : 's'})`;
    case 'attention':
      return 'Needs your attention';
    case 'paused':
      return 'Paused';
    case 'active':
      return processing.currentStatus ? humanProcessingLabel(processing.currentStatus).replace('…', '') : 'Working';
    case 'waiting':
      return scheduleReason ?? 'New recordings waiting';
    case 'idle':
      return 'Ready';
  }
}

function statusLine(
  inbox: number,
  errors: number,
  last: LastPollResult | null,
  processing: ProcessingSummary,
  paused: PauseConfig,
  scheduleReason: string | null,
): string {
  const bits: string[] = [];
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
    bits.push('Paused');
  } else {
    bits.push(`Sync failed ${formatRelative(last.at)}`);
  }
  if (processing.queued > 0) {
    bits.push(`${processing.queued} queued`);
  }
  if (scheduleReason) bits.push(scheduleReason);
  if (inbox > 0) bits.push(`${inbox} in inbox`);
  if (errors > 0) bits.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

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
    ...PAUSABLE_STEPS.map(
      (step): Electron.MenuItemConstructorOptions => ({
        label: stepLabels[step],
        type: 'checkbox',
        // When master is on, show per-step items as unchecked + disabled.
        // Their stored values are preserved so flipping master off restores
        // them; we just don't expose that visually because it would imply
        // they have effect right now.
        checked: paused.all ? false : paused[step],
        enabled: !paused.all,
        click: () => onPauseChange({ ...paused, [step]: !paused[step] }),
      }),
    ),
  ];
  return {
    label: 'Pause',
    submenu,
  };
}

function humanProcessingLabel(s: RecordingStatus): string {
  switch (s) {
    case 'downloading':
      return 'Downloading…';
    case 'transcribing':
      return 'Transcribing…';
    case 'summarising':
      return 'Summarising…';
    case 'writing':
      return 'Writing…';
    default:
      return '';
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

// Fallback-only glyph colours, used solely when an Essence tray PNG is
// missing from resources/icons (see loadTrayIcon). The real assets are
// all black/alpha templates; this fallback still uses colour so a broken
// install is at least visually distinguishable at a glance.
const STATE_COLOUR: Record<Exclude<TrayState, 'idle' | 'waiting'>, string> = {
  active: '#22c55e', // green-500
  paused: '#f59e0b', // amber-500
  attention: '#f59e0b', // amber-500
  error: '#ef4444', // red-500
};

/**
 * States drawn in colour; everything else stays a monochrome template that
 * macOS adapts to the menu bar. Colour is kept for "look at me" so it keeps
 * meaning something.
 */
export const TINTED_STATES: Partial<Record<TrayState, [number, number, number]>> = {
  error: [0xef, 0x44, 0x44], // red-500
  attention: [0xf5, 0x9e, 0x0b], // amber-500
};

/**
 * Recolour a BGRA bitmap (as NativeImage.toBitmap returns, premultiplied)
 * to one colour, keeping its alpha — turns a black template glyph into a
 * coloured one without separate artwork.
 */
export function tintBgra(bitmap: Uint8Array, rgb: [number, number, number]): Buffer {
  const out = Buffer.from(bitmap);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = out[i + 3];
    out[i] = Math.round((rgb[2] * a) / 255);
    out[i + 1] = Math.round((rgb[1] * a) / 255);
    out[i + 2] = Math.round((rgb[0] * a) / 255);
  }
  return out;
}

function tintImage(template: NativeImage, rgb: [number, number, number]): NativeImage {
  const { width, height } = template.getSize();
  const out = nativeImage.createEmpty();
  for (const scaleFactor of [1, 2]) {
    const bitmap = template.toBitmap({ scaleFactor });
    const w = Math.round(width * scaleFactor);
    const h = Math.round(height * scaleFactor);
    if (bitmap.length !== w * h * 4) continue; // no representation at this scale
    const png = nativeImage.createFromBitmap(tintBgra(bitmap, rgb), { width: w, height: h, scaleFactor }).toPNG();
    out.addRepresentation({ scaleFactor, width: w, height: h, dataURL: `data:image/png;base64,${png.toString('base64')}` });
  }
  return out.isEmpty() ? template : out;
}

const PNG_FILENAME: Record<TrayState, string> = {
  idle: 'EssenceIdleTemplate.png',
  waiting: 'EssenceWaitingTemplate.png',
  active: 'EssenceActiveTemplate.png',
  paused: 'EssencePausedTemplate.png',
  error: 'EssenceErrorTemplate.png',
  // Same "!" drop as error, drawn amber: needs you, but nothing has failed.
  attention: 'EssenceErrorTemplate.png',
};

/**
 * Every Essence tray PNG is a black/alpha template — unlike the old
 * mic-glyph set, none of them carry colour, so setTemplateImage applies
 * unconditionally and macOS handles light/dark menu bars itself.
 */
function loadTrayIcon(resourcesDir: string, state: TrayState, logger?: Logger): NativeImage {
  const filename = PNG_FILENAME[state];
  const iconPath = path.join(resourcesDir, 'icons', filename);
  const fromFile = nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) {
    const tint = TINTED_STATES[state];
    if (tint) {
      const coloured = tintImage(fromFile, tint);
      coloured.setTemplateImage(false);
      return coloured;
    }
    fromFile.setTemplateImage(true);
    return fromFile;
  }
  logger?.warn(
    { state, iconPath },
    'Tray icon PNG not found in resources/icons — falling back to a plain glyph. Re-copy the Essence asset pack\'s tray/ files into resources/icons/.',
  );
  return renderFallbackIconSvg(state, logger);
}

function renderFallbackIconSvg(state: TrayState, logger?: Logger): NativeImage {
  const isTemplate = state === 'idle' || state === 'waiting';
  const fill = isTemplate ? 'black' : STATE_COLOUR[state];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5" y="1.5" width="6" height="9" rx="3" fill="${fill}"/><path d="M3 7.5 v1 a5 5 0 0 0 10 0 v-1" stroke="${fill}" stroke-width="1.5" fill="none" stroke-linecap="round"/><rect x="7" y="13" width="2" height="2" fill="${fill}"/></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) {
    logger?.warn(
      { state, svgLen: svg.length },
      'tray icon: SVG fallback also produced an empty NativeImage.',
    );
    return nativeImage.createEmpty();
  }
  img.setTemplateImage(isTemplate);
  return img;
}
