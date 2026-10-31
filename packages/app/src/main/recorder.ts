import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from './logger.js';
import { isOnPath } from './localImport.js';
import type { CallTracks } from './callTracks.js';

/** Raised with a message that is safe to show the user as-is. */
export class RecorderError extends Error {
  userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = 'RecorderError';
  }
}

export type CaptureEvent =
  | { event: 'ready'; mic: boolean }
  | { event: 'level'; system: number; mic: number }
  | { event: 'warning'; message: string }
  | { event: 'error'; message: string }
  | { event: 'stopped' };

/** One line of the helper's stdout. Anything that isn't a known event is null. */
export function parseCaptureEvent(line: string): CaptureEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  switch (r.event) {
    case 'ready':
      return { event: 'ready', mic: r.mic === true };
    case 'level':
      return {
        event: 'level',
        system: typeof r.system === 'number' ? r.system : 0,
        mic: typeof r.mic === 'number' ? r.mic : 0,
      };
    case 'warning':
    case 'error':
      return typeof r.message === 'string' ? { event: r.event, message: r.message } : null;
    case 'stopped':
      return { event: 'stopped' };
    default:
      return null;
  }
}

/**
 * macOS hands a process silence — not an error — when System Audio Recording
 * permission is missing, and a call that never started sounds the same. So
 * the only way to notice is to watch the level and say so.
 */
export class NoSignalWatch {
  private seen = false;
  private warned = false;
  private ticks = 0;

  constructor(
    private readonly afterSeconds = 45,
    private readonly threshold = 0.0005,
  ) {}

  /** Feed one system-level reading per second. True exactly once, when it's time to warn. */
  feed(systemPeak: number): boolean {
    if (this.seen || this.warned) return false;
    if (systemPeak > this.threshold) {
      this.seen = true;
      return false;
    }
    this.ticks++;
    if (this.ticks < this.afterSeconds) return false;
    this.warned = true;
    return true;
  }
}

/** Compress one raw capture track to a speech-quality mono mp3. */
export function buildTrackArgs(wav: string, outMp3: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-i', wav, '-ac', '1', '-b:a', '64k', outMp3];
}

/**
 * Mix the system and microphone tracks to one mono mp3. amix halves each
 * input, so volume=2 puts the mix back at the level of the loudest source.
 */
export function buildMixArgs(systemWav: string, micWav: string, outMp3: string): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', systemWav,
    '-i', micWav,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=longest,volume=2[a]',
    '-map', '[a]',
    '-ac', '1', '-b:a', '64k',
    outMp3,
  ];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** "Call 2026-10-31 15-59.mp3" — local time, no characters Finder dislikes. */
export function callFilename(d: Date): string {
  return `Call ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}.mp3`;
}

export interface RecorderDeps {
  logger: Logger;
  /** Absolute path to the distill-capture helper. */
  helperPath: string;
  /** Where in-progress captures live. Must not be swept by audio retention. */
  scratchRoot: string;
  /**
   * Hand the finished mp3 to the normal import path. `tracks` are the
   * separate mic/others mp3s (null if they couldn't be made) and must be
   * moved next to the imported audio before this resolves.
   */
  importFile: (mp3Path: string, tracks: CallTracks | null) => Promise<void>;
  /** Non-fatal things the user should hear about (permission, mic missing). */
  onWarning: (message: string) => void;
  /** Recording started or stopped. */
  onChange: (startedAt: number | null) => void;
}

interface Active {
  proc: ChildProcess;
  dir: string;
  systemWav: string;
  micWav: string;
  startedAt: number;
  stopping: boolean;
  finished: Promise<void>;
}

export interface Recorder {
  start(): Promise<void>;
  /** Stops, mixes and imports. Resolves once the recording is in the inbox. */
  stop(): Promise<void>;
  startedAt(): number | null;
}

export function createRecorder(deps: RecorderDeps): Recorder {
  const { logger } = deps;
  let active: Active | null = null;
  let starting = false;

  const ffmpeg = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', args);
      let stderr = '';
      p.stderr.on('data', (c) => (stderr += String(c)));
      p.on('error', reject);
      p.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`)),
      );
    });

  const mix = (a: Active, out: string): Promise<void> =>
    ffmpeg(buildMixArgs(a.systemWav, a.micWav, out));

  /** Separate tracks are what let the transcriber label speakers. Optional: failure only costs the labels. */
  const compressTracks = async (a: Active): Promise<CallTracks | null> => {
    const tracks = { mic: path.join(a.dir, 'mic.mp3'), others: path.join(a.dir, 'others.mp3') };
    try {
      await ffmpeg(buildTrackArgs(a.micWav, tracks.mic));
      await ffmpeg(buildTrackArgs(a.systemWav, tracks.others));
      return tracks;
    } catch (e) {
      logger.warn({ err: String(e) }, 'could not keep separate call tracks; transcript will not be speaker-labelled');
      return null;
    }
  };

  /** Mix + import, then clear scratch. On any failure the raw tracks are kept. */
  const finish = async (a: Active): Promise<void> => {
    const mp3 = path.join(a.dir, callFilename(new Date(a.startedAt)));
    try {
      await mix(a, mp3);
      const tracks = await compressTracks(a);
      // The importer stamps start_time from mtime; make that the call's start.
      const t = new Date(a.startedAt);
      fs.utimesSync(mp3, t, t);
      await deps.importFile(mp3, tracks);
      fs.rmSync(a.dir, { recursive: true, force: true });
    } catch (e) {
      logger.error({ err: String(e), dir: a.dir }, 'call recording could not be imported; raw tracks kept');
      throw new RecorderError(
        `The call was recorded but could not be imported. The raw audio is kept in ${a.dir}.`,
      );
    }
  };

  return {
    startedAt: () => active?.startedAt ?? null,

    async start() {
      if (active || starting) throw new RecorderError('A call is already being recorded.');
      if (process.platform !== 'darwin') throw new RecorderError('Call recording is macOS only.');
      if (!fs.existsSync(deps.helperPath)) {
        throw new RecorderError(
          'The audio capture helper is missing. Build it with: npm run build:capture (in packages/app).',
        );
      }
      if (!isOnPath('ffmpeg')) {
        throw new RecorderError(
          'ffmpeg is not installed, which call recording needs to produce the audio file. Install it with: brew install ffmpeg.',
        );
      }
      starting = true;
      const startedAt = Date.now();
      const dir = path.join(deps.scratchRoot, String(startedAt));
      fs.mkdirSync(dir, { recursive: true });
      const systemWav = path.join(dir, 'system.wav');
      const micWav = path.join(dir, 'mic.wav');

      try {
        const proc = spawn(deps.helperPath, [systemWav, micWav], { stdio: ['ignore', 'pipe', 'pipe'] });
        const watch = new NoSignalWatch();
        let helperError: string | null = null;
        let onReady: (() => void) | null = null;
        let onFail: ((m: string) => void) | null = null;

        let buf = '';
        proc.stdout!.on('data', (chunk) => {
          buf += String(chunk);
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const ev = parseCaptureEvent(buf.slice(0, nl));
            buf = buf.slice(nl + 1);
            if (!ev) continue;
            if (ev.event === 'ready') onReady?.();
            else if (ev.event === 'error') {
              helperError = ev.message;
              onFail?.(ev.message);
            } else if (ev.event === 'warning') deps.onWarning(ev.message);
            else if (ev.event === 'level' && watch.feed(ev.system)) {
              deps.onWarning(
                'No call audio is being captured. Check that the call is playing, and that distill is allowed under System Settings → Privacy & Security → Screen & System Audio Recording.',
              );
            }
          }
        });
        proc.stderr!.on('data', (c) => logger.warn({ stderr: String(c).trim() }, 'distill-capture stderr'));

        const exited = new Promise<number | null>((resolve) => proc.on('close', (code) => resolve(code)));

        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The capture helper did not start in time.')), 10_000);
          onReady = () => { clearTimeout(timer); resolve(); };
          onFail = (m) => { clearTimeout(timer); reject(new Error(m)); };
          proc.once('error', (e) => { clearTimeout(timer); reject(e); });
          void exited.then((code) => { clearTimeout(timer); reject(new Error(helperError ?? `The capture helper exited (${code}).`)); });
        });

        const a: Active = {
          proc, dir, systemWav, micWav, startedAt, stopping: false,
          finished: Promise.resolve(),
        };
        active = a;
        logger.info({ dir }, 'call recording started');
        deps.onChange(startedAt);

        // Helper died on its own (crash, device change). Salvage what exists.
        void exited.then(async (code) => {
          if (active !== a || a.stopping) return;
          logger.error({ code }, 'capture helper exited mid-recording');
          active = null;
          deps.onChange(null);
          deps.onWarning('Recording stopped unexpectedly. Saving what was captured.');
          try { await finish(a); } catch (e) { deps.onWarning(e instanceof RecorderError ? e.userMessage : String(e)); }
        });
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new RecorderError(e instanceof Error ? e.message : String(e));
      } finally {
        starting = false;
      }
    },

    async stop() {
      const a = active;
      if (!a) throw new RecorderError('No call is being recorded.');
      a.stopping = true;
      active = null;
      deps.onChange(null);

      const closed = new Promise<void>((resolve) => {
        if (a.proc.exitCode !== null) return resolve();
        a.proc.once('close', () => resolve());
      });
      a.proc.kill('SIGINT');
      const killTimer = setTimeout(() => a.proc.kill('SIGKILL'), 10_000);
      await closed;
      clearTimeout(killTimer);
      logger.info({ seconds: Math.round((Date.now() - a.startedAt) / 1000) }, 'call recording stopped');
      await finish(a);
    },
  };
}
