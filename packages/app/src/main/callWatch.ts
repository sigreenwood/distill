import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import type { Logger } from './logger.js';

export interface CallEvent {
  active: boolean;
  /** Bundle id of the app holding the microphone, e.g. "us.zoom.xos". */
  app: string;
}

/** One line of the watcher's stdout; anything but a call event is null. */
export function parseCallEvent(line: string): CallEvent | null {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (o.event !== 'call' || typeof o.active !== 'boolean' || typeof o.app !== 'string') return null;
    return { active: o.active, app: o.app };
  } catch {
    return null;
  }
}

export function callAppName(bundleId: string): string {
  if (bundleId.startsWith('us.zoom.')) return 'Zoom';
  if (bundleId.startsWith('com.microsoft.teams')) return 'Teams';
  return 'A';
}

export interface CallWatch {
  stop(): void;
}

const MAX_RESTARTS = 5;

/**
 * Runs the distill-callwatch helper and relays call start/end. If the helper
 * dies it is restarted a few times, then left off: detection is a
 * convenience, and the tray's Record call always works without it.
 */
export function startCallWatch(
  helperPath: string,
  logger: Logger,
  onEvent: (e: CallEvent) => void,
): CallWatch | null {
  if (!fs.existsSync(helperPath)) {
    logger.info({ helperPath }, 'call watcher not built; call detection off');
    return null;
  }
  let proc: ChildProcess | null = null;
  let stopped = false;
  let restarts = 0;

  const launch = () => {
    proc = spawn(helperPath, [], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    proc.stdout!.on('data', (chunk) => {
      buf += String(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const ev = parseCallEvent(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (ev) onEvent(ev);
      }
    });
    proc.on('close', (code) => {
      if (stopped) return;
      logger.warn({ code, restarts }, 'call watcher exited');
      if (++restarts <= MAX_RESTARTS) setTimeout(launch, 5000);
    });
  };
  launch();

  return {
    stop: () => {
      stopped = true;
      proc?.kill('SIGTERM');
    },
  };
}
