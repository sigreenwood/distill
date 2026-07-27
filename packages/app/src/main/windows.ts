import path from 'node:path';
import { BrowserWindow, screen, type Rectangle } from 'electron';
import { Channels } from '../shared/ipcChannels.js';

export interface WindowsContext {
  preloadPath: string;
  /** Set in dev mode (electron-vite dev server); undefined in packaged builds. */
  rendererDevUrl?: string;
  /** Renderer dist directory for packaged builds. */
  rendererDistDir: string;
}

type RendererEntry = 'inbox' | 'tag' | 'settings' | 'setup';

let ctx: WindowsContext | null = null;
let inboxWin: BrowserWindow | null = null;
let tagWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let pendingFocusId: string | null = null;

export function configureWindows(c: WindowsContext): void {
  ctx = c;
}

export function openInbox(trayBounds?: Rectangle, focusRecordingId?: string): void {
  if (!ctx) throw new Error('configureWindows must be called first');
  if (focusRecordingId) pendingFocusId = focusRecordingId;
  if (inboxWin && !inboxWin.isDestroyed()) {
    positionUnderTray(inboxWin, trayBounds);
    inboxWin.show();
    inboxWin.focus();
    if (pendingFocusId) {
      inboxWin.webContents.send(Channels.PushFocusRecording, pendingFocusId);
      pendingFocusId = null;
    }
    return;
  }
  inboxWin = new BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    fullscreenable: false,
    title: 'distill — Inbox',
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs Node for ipcRenderer types
    },
  });
  positionUnderTray(inboxWin, trayBounds);
  void loadRendererEntry(inboxWin, 'inbox');
  inboxWin.once('ready-to-show', () => {
    inboxWin?.show();
    if (pendingFocusId) {
      inboxWin?.webContents.send(Channels.PushFocusRecording, pendingFocusId);
      pendingFocusId = null;
    }
  });
  inboxWin.on('closed', () => {
    inboxWin = null;
  });
}

export function openTagSheet(recordingId: string): void {
  if (!ctx) throw new Error('configureWindows must be called first');
  if (tagWin && !tagWin.isDestroyed()) {
    tagWin.close();
    tagWin = null;
  }
  tagWin = new BrowserWindow({
    width: 420,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    // Not a child of the inbox — on macOS, child windows of frameless
    // parents inherit weird behaviour (off-screen placement, unexpected
    // close-on-parent-blur). Keep the tag sheet fully independent.
    skipTaskbar: true,
    fullscreenable: false,
    title: 'distill — Tag recording',
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--recording-id=${recordingId}`],
    },
  });
  positionTagSheet(tagWin);
  void loadRendererEntry(tagWin, 'tag');
  tagWin.once('ready-to-show', () => {
    tagWin?.show();
    tagWin?.focus();
  });
  tagWin.on('closed', () => {
    tagWin = null;
  });
}

export function closeAll(): void {
  if (inboxWin && !inboxWin.isDestroyed()) inboxWin.close();
  if (tagWin && !tagWin.isDestroyed()) tagWin.close();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  inboxWin = null;
  tagWin = null;
  settingsWin = null;
  setupWin = null;
}

export function openSettings(opts?: { initialTab?: string }): void {
  if (!ctx) throw new Error('configureWindows must be called first');
  const hash = opts?.initialTab ? `#${opts.initialTab}` : '';
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (hash) {
      const current = settingsWin.webContents.getURL();
      const base = current.split('#')[0];
      void settingsWin.loadURL(`${base}${hash}`);
    }
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 720,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'distill — Settings',
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  centreOnCursorDisplay(settingsWin);
  void loadRendererEntry(settingsWin, 'settings', hash);
  settingsWin.once('ready-to-show', () => {
    settingsWin?.show();
    settingsWin?.focus();
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

export function openSetup(): BrowserWindow {
  if (!ctx) throw new Error('configureWindows must be called first');
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return setupWin;
  }
  setupWin = new BrowserWindow({
    width: 640,
    height: 520,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'distill — Setup',
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  centreOnCursorDisplay(setupWin);
  void loadRendererEntry(setupWin, 'setup');
  setupWin.once('ready-to-show', () => {
    setupWin?.show();
    setupWin?.focus();
  });
  setupWin.on('closed', () => {
    setupWin = null;
  });
  return setupWin;
}

function centreOnCursorDisplay(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}

async function loadRendererEntry(
  win: BrowserWindow,
  entry: RendererEntry,
  hash = '',
): Promise<void> {
  if (!ctx) return;
  if (ctx.rendererDevUrl) {
    await win.loadURL(`${ctx.rendererDevUrl}/${entry}/index.html${hash}`);
  } else {
    if (hash) {
      const filePath = path.join(ctx.rendererDistDir, entry, 'index.html');
      await win.loadFile(filePath, { hash: hash.replace(/^#/, '') });
    } else {
      await win.loadFile(path.join(ctx.rendererDistDir, entry, 'index.html'));
    }
  }
}

function positionUnderTray(win: BrowserWindow, trayBounds?: Rectangle): void {
  const bounds = win.getBounds();
  const display = trayBounds
    ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    : screen.getPrimaryDisplay();
  if (trayBounds) {
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 4);
    const workArea = display.workArea;
    if (x + bounds.width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - bounds.width - 8;
    }
    if (x < workArea.x + 8) x = workArea.x + 8;
    win.setPosition(x, y, false);
  } else {
    centreOnCurrentDisplay(win);
  }
}

function centreOnCurrentDisplay(win: BrowserWindow): void {
  const bounds = win.getBounds();
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}

function positionTagSheet(win: BrowserWindow): void {
  const bounds = win.getBounds();
  let display: Electron.Display;
  if (inboxWin && !inboxWin.isDestroyed()) {
    const ib = inboxWin.getBounds();
    display = screen.getDisplayNearestPoint({
      x: ib.x + Math.round(ib.width / 2),
      y: ib.y + Math.round(ib.height / 2),
    });
  } else {
    display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}
