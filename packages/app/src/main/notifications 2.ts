/**
 * macOS user-visible notifications via Electron's main-process Notification API.
 *
 * Electron's Notification constructor is available in the main process since
 * v22. Clicks are optional — we don't need them for M1a ("new recording"),
 * but the API is here for M2 ("summary ready") to attach an action that
 * reveals the Markdown in Finder.
 */

import { Notification } from 'electron';

export interface NotifyOptions {
  title: string;
  body: string;
  /** Called when the user clicks the notification body. */
  onClick?: () => void;
  /** Silence the banner (still appears in Notification Centre). */
  silent?: boolean;
}

export function notify(opts: NotifyOptions): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: opts.title,
    body: opts.body,
    silent: opts.silent ?? false,
  });
  if (opts.onClick) n.on('click', opts.onClick);
  n.show();
}
