import path from 'node:path';
import { app, shell, Menu, Tray, nativeImage, type NativeImage, type Rectangle } from 'electron';
import {
  PAUSABLE_STEPS,
  formatPauseStatus,
  pausedSteps,
  type AppConfig,
  type PauseConfig,
  type PausableStep,
} from './config.js';
import { logsDir } from './paths.js';
import type { Logger } from './logger.js';
import type { ProcessingSummary, RecordingStatus, State } from './state.js';
import { TIP_JAR_URL } from './tipJar.js';

export type TrayState = 'idle' | 'processing' | 'paused' | 'error';

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
  onSyncNow: () => Promise<void> | void;
  onPauseChange: (next: PauseConfig) => void;
}

export interface TrayHandle {
  refresh: () => void;
  setLastPoll: (r: LastPollResult) => void;
  setOllamaWarning: (m: string | null) => void;
  destroy: () => void;
}

export function computeTrayState(inputs: {
  processingRunning: boolean;
  paused: boolean;
  errorCount: number;
}): TrayState {
  if (inputs.processingRunning) return 'processing';
  if (inputs.paused) return 'paused';
  if (inputs.errorCount > 0) return 'error';
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
  tray.setToolTip('distill');

  let lastPoll: LastPollResult | null = null;
  let ollamaWarning: string | null = null;
  let currentState: TrayState = 'idle';

  const rebuild = () => {
    const inbox = ctx.state.inboxCount();
    const errors = ctx.state.errorCount();
    const processing = ctx.state.processingSummary();
    const cfg = ctx.getConfig();
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
    let title = '';
    if (inbox > 0) title += ` ${inbox}`;
    if (errors > 0) title += ' ⚠';
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
      rebuild();
    },
    setOllamaWarning: (m) => {
      ollamaWarning = m;
      rebuild();
    },
    destroy: () => tray.destroy(),
  };
}

function statusLine(
  inbox: number,
  errors: number,
  last: LastPollResult | null,
  processing: ProcessingSummary,
  paused: PauseConfig,
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

const STATE_COLOUR: Record<Exclude<TrayState, 'idle'>, string> = {
  processing: '#22c55e', // green-500
  paused: '#f59e0b', // amber-500
  error: '#ef4444', // red-500
};

const PNG_FILENAME: Record<TrayState, string> = {
  idle: 'trayTemplate.png',
  processing: 'trayProcessing.png',
  paused: 'trayPaused.png',
  error: 'trayError.png',
};

function loadTrayIcon(resourcesDir: string, state: TrayState, logger?: Logger): NativeImage {
  const filename = PNG_FILENAME[state];
  const iconPath = path.join(resourcesDir, 'icons', filename);
  const fromFile = nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) {
    if (state === 'idle') fromFile.setTemplateImage(true);
    return fromFile;
  }
  logger?.warn(
    { state, iconPath },
    `Tray icon PNG not found. Run: python3 scripts/generate-tray-icons.py (from packages/app) to generate all four state icons at 22px + @2x.`,
  );
  return renderMicrophoneIconSvg(state, logger);
}

function renderMicrophoneIconSvg(state: TrayState, logger?: Logger): NativeImage {
  const isTemplate = state === 'idle';
  const fill = isTemplate ? 'black' : STATE_COLOUR[state as Exclude<TrayState, 'idle'>];
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
