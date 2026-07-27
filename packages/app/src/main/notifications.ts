import { Notification } from 'electron';

export interface NotifyOptions {
  title: string;
  body: string;
  silent?: boolean;
  onClick?: () => void;
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
