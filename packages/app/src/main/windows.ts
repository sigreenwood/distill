/**
 * Window manager.
 *
 * Creates and manages the inbox and tag-sheet BrowserWindows. Both are
 * frameless, non-resizable, and deliberately minimal in Electron decoration
 * so macOS users perceive them as panels anchored to the tray.
 *
 * Key behaviour:
 *   - At most one inbox window open at a time; second open calls focus it.
 *   - Tag sheet opens on demand with a recording id and is disposed on close.
 *   - openInboxAt(bounds) positions the inbox under the tray icon.
 *   - broadcastFocusRecording() asks the inbox renderer to scroll to a row.
 */

import { BrowserWindow, screen, type Rectangle } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Channels } from '../shared/ipc-contract.js';

export interface WindowsContext {
  /** Path on disk of the preload script (built to `out/preload/index.js`). */
  preloadPath: string;
  /** Dev server URL when running under `electron-vite dev`, null in production. */
  rendererDevUrl: string | null;
  /** Absolute path to built renderer HTML files in production. */
  rendererDistDir: string;
}

let ctx: WindowsContext | null = null;
let inboxWin: BrowserWindow | null = null;
let tagWin: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let pendingFocusId: string | null = null;

export function configureWindows(c: WindowsContext): void {
  ctx = c;
}

/**
 * Open (or focus) the inbox window. If `trayBounds` is provided, position
 * the window just below the tray icon; otherwise centre on the current
 * display.
 */
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

  // Close on Escape — handled in the renderer via window.close(). The
  // previous blur-to-hide behaviour was removed because it made it too easy
  // to lose the window without realising: if focus moved to a terminal or
  // another app briefly, the panel would vanish and the user would have to
  // go back to the tray to reopen it. Explicit close is less surprising.

  inboxWin.on('closed', () => {
    inboxWin = null;
  });
}

/** Open a tag sheet for a specific recording. Closes any previous one. */
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

  // Position on the same display as the inbox when it's open; otherwise on
  // the display containing the current cursor. This keeps the sheet near
  // the user's attention rather than jumping to an arbitrary primary display.
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

/**
 * Open (or focus) the Settings window. Centred on the display nearest
 * the cursor so it doesn't jump between monitors on dual-display setups.
 * Unlike the inbox, this is a regular-ish window with a standard close
 * button — users expect Settings to behave like System Settings does.
 *
 * `initialTab` lets a caller drop the user onto a specific tab — e.g.
 * the inbox "Sign in again" button opens Settings on the Sources tab.
 * Passed to the renderer as a URL hash (`#sources`); Settings.tsx reads
 * `window.location.hash` on mount to pick the initial tab. Hashes
 * (rather than query params) keep the URL identical in dev and packaged
 * builds, where the hosting URL changes between dev-server and file://.
 *
 * If the window is already open, the hash on the loaded URL is updated
 * in place so the renderer can react via the `hashchange` event.
 */
export function openSettings(opts?: { initialTab?: string }): void {
  if (!ctx) throw new Error('configureWindows must be called first');

  const hash = opts?.initialTab ? `#${opts.initialTab}` : '';

  if (settingsWin && !settingsWin.isDestroyed()) {
    if (hash) {
      // Window already open: update the hash so the renderer can
      // react. We can't reload the URL without losing in-progress
      // edits in other tabs, so we go through the renderer's
      // hashchange event.
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

/**
 * Open the first-launch setup window. Caller is the bootstrap code
 * in `index.ts`, which only opens this window when
 * `getInstallationStatus()` returned 'needs-setup' or 'python-missing'.
 *
 * Returns the BrowserWindow so the bootstrap can await its 'closed'
 * event — setup is gating, the rest of app startup waits until the
 * user either completes setup or quits.
 *
 * Centred on the cursor display so it lands wherever the user is
 * looking, not on a primary monitor they aren't using. Slightly
 * larger than Settings (640x520) because the explainer + log
 * textarea need vertical room.
 */
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadRendererEntry(
  win: BrowserWindow,
  entry: 'inbox' | 'tag' | 'settings' | 'setup',
  hash = '',
): Promise<void> {
  if (!ctx) return;

  if (ctx.rendererDevUrl) {
    // electron-vite dev mode — each entry is served at /<entry>/index.html
    await win.loadURL(`${ctx.rendererDevUrl}/${entry}/index.html${hash}`);
  } else {
    // Production — HTML files are emitted to out/renderer/<entry>/index.html
    if (hash) {
      const filePath = join(ctx.rendererDistDir, entry, 'index.html');
      await win.loadFile(filePath, { hash: hash.replace(/^#/, '') });
    } else {
      await win.loadFile(join(ctx.rendererDistDir, entry, 'index.html'));
    }
  }
}

function positionUnderTray(win: BrowserWindow, trayBounds?: Rectangle): void {
  const bounds = win.getBounds();
  const display = trayBounds
    ? screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
    : screen.getPrimaryDisplay();

  if (trayBounds) {
    // Centre horizontally under the tray icon, 4px below the menu bar.
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 4);

    // Don't let the panel run off the right edge of the display.
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

  // Prefer the display containing the inbox (if open). Fall back to the
  // display under the cursor. Never fall back to primary — primary can be
  // a different monitor than the user is currently looking at.
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
