/**
 * Local audio/video import.
 *
 * Accepts a file path from disk (via tray drop, Dock drop, Finder drop on
 * the inbox window, or native Open dialog) and creates an inbox recording
 * from it. Supported formats:
 *
 *   - .mp3, .m4a, .wav, .aac, .ogg, .flac, .opus  ← passed straight through
 *   - .mp4, .mov, .m4v, .mkv, .webm                ← audio stripped via ffmpeg
 *
 * ffmpeg is a runtime requirement only for video imports. If the user drops
 * an MP4 and ffmpeg is not on PATH, we surface a clear error suggesting
 * `brew install ffmpeg`. Audio-only imports work without ffmpeg.
 *
 * Imported recordings land with `source: 'local'` and `audio_path` already
 * populated, so the pipeline's per-step skip logic automatically bypasses
 * the download step. Transcription onwards behaves identically to Plaud-
 * sourced recordings.
 *
 * Progress reporting
 * ------------------
 * `importLocalFile` accepts an optional `onProgress` callback that fires
 * as the import advances through its phases:
 *
 *   - phase: 'probe'    — running ffprobe on the source (very brief)
 *   - phase: 'copy'     — streaming an audio file into the cache
 *   - phase: 'extract'  — ffmpeg extracting audio from a video
 *   - phase: 'finalise' — writing the DB row
 *
 * `percent` is 0-100 when computable, otherwise null. The IPC layer
 * pushes these to all renderer windows; the inbox UI uses them to
 * render a per-row progress indicator. The callback is best-effort —
 * if it throws, the import continues anyway.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { audioDir } from './paths.js';
import type { State } from './state.js';

export type LocalImportKind = 'audio-passthrough' | 'video-extract-audio' | 'unsupported';

/** Recognised audio extensions — copied verbatim into the audio cache. */
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus']);

/** Video-ish container extensions — audio extracted via ffmpeg. */
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);

export interface LocalImportResult {
  recordingId: string;
  kind: LocalImportKind;
  /** Absolute path to the audio file stored in the distill audio dir. */
  audioPath: string;
  /** Seconds, or null if ffprobe wasn't available to extract it. */
  durationSeconds: number | null;
}

/**
 * Phases of an in-flight import. Matches the per-row UI states the
 * inbox renders. `percent` is 0-100 where computable; null where the
 * underlying operation does not give us granular progress (e.g. when
 * ffprobe isn't installed and we're extracting from a video without
 * a known duration).
 */
export interface LocalImportProgress {
  /** Path of the source file being processed. Used by the renderer to identify the queue row. */
  sourcePath: string;
  phase: 'probe' | 'copy' | 'extract' | 'finalise';
  percent: number | null;
}

export type LocalImportProgressCallback = (p: LocalImportProgress) => void;

export class LocalImportError extends Error {
  constructor(public userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = 'LocalImportError';
    if (cause instanceof Error) this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
  }
}

/**
 * Classify a file by extension. Extension-based only — we don't sniff
 * magic bytes in v1. If the user renames an MP4 to .mp3, ffmpeg will
 * complain during transcription and we'll surface that error then.
 */
export function classifyPath(path: string): LocalImportKind {
  const ext = extname(path).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return 'audio-passthrough';
  if (VIDEO_EXTS.has(ext)) return 'video-extract-audio';
  return 'unsupported';
}

export interface LocalImportDeps {
  state: State;
  logger: Logger;
  /**
   * Optional progress sink. Called multiple times per import. Errors
   * thrown by the callback are caught and logged; they never abort
   * the import.
   */
  onProgress?: LocalImportProgressCallback;
}

/**
 * Import a single file. The returned recording lands in `inbox` status with
 * the same shape as a Plaud-sourced row, except source='local' and
 * audio_path is already populated.
 *
 * Rejects loudly on any problem so the caller (IPC handler) can surface a
 * useful error to the user.
 */
export async function importLocalFile(
  srcPath: string,
  deps: LocalImportDeps,
): Promise<LocalImportResult> {
  if (!existsSync(srcPath)) {
    throw new LocalImportError(`File not found: ${srcPath}`);
  }

  const kind = classifyPath(srcPath);
  if (kind === 'unsupported') {
    throw new LocalImportError(
      `Unsupported file type: ${extname(srcPath) || '(no extension)'}. ` +
        `Accepted formats: ${[...AUDIO_EXTS, ...VIDEO_EXTS].sort().join(', ')}.`,
    );
  }

  const dir = audioDir();
  mkdirSync(dir, { recursive: true });

  const id = `local-${randomUUID().slice(0, 12)}`;
  const originalName = basename(srcPath);
  const dest = join(dir, `${id}.mp3`); // always normalise to .mp3 for disk uniformity

  // Wrapped progress emitter that swallows callback errors. The
  // pipeline must never break because a renderer push failed — the
  // worst that can happen is the UI looks stuck for a moment.
  const emit = (phase: LocalImportProgress['phase'], percent: number | null): void => {
    if (!deps.onProgress) return;
    try {
      deps.onProgress({ sourcePath: srcPath, phase, percent });
    } catch (e) {
      deps.logger.warn({ err: String(e) }, 'progress callback threw — ignoring');
    }
  };

  // ---------------------------------------------------------------------
  // Probe duration FIRST (when possible) so the extract step has a
  // denominator for percent reporting. For audio-passthrough this is
  // a nice-to-have; for video extraction it's the only way to compute
  // a meaningful percent (ffmpeg's stderr gives us elapsed time, we
  // need total time to divide).
  // ---------------------------------------------------------------------
  emit('probe', null);
  const sourceDuration = probeDurationSeconds(srcPath);

  // ---------------------------------------------------------------------
  // Get the audio onto disk
  // ---------------------------------------------------------------------
  if (kind === 'audio-passthrough') {
    deps.logger.info({ src: srcPath, dest, originalName }, 'copying local audio');
    await streamingCopyWithProgress(srcPath, dest, (percent) => emit('copy', percent));
  } else {
    // Video: extract audio via ffmpeg into an mp3.
    await extractAudioFromVideo(srcPath, dest, sourceDuration, deps.logger, (percent) =>
      emit('extract', percent),
    );
  }

  // Sanity check: file exists and is non-empty.
  const size = statSync(dest).size;
  if (size === 0) {
    unlinkSync(dest);
    throw new LocalImportError('Resulting audio file is empty.');
  }

  // ---------------------------------------------------------------------
  // For audio-passthrough we already have sourceDuration (same file).
  // For video we re-probe the produced mp3 because ffmpeg may have
  // adjusted timing during transcoding (silence trimming, etc.).
  // ---------------------------------------------------------------------
  emit('finalise', null);
  const durationSeconds =
    kind === 'audio-passthrough' && sourceDuration !== null
      ? sourceDuration
      : probeDurationSeconds(dest);

  // ---------------------------------------------------------------------
  // Insert the recording row
  // ---------------------------------------------------------------------
  const now = Date.now();
  deps.state.insertRecording({
    id,
    filename: originalName,
    duration_seconds: durationSeconds,
    start_time: fileMtime(srcPath) ?? now,
    filesize_bytes: size,
    synced_at: now,
    status: 'inbox',
    client_id: null,
    meeting_type_id: null,
    audio_path: dest,
    transcript_text: null,
    summary_text: null,
    markdown_path: null,
    error: null,
    is_auth_error: 0,
    last_step: null,
    prompt_snapshot: null,
    model_snapshot: null,
    whisper_snapshot: null,
    vocabulary_sources: null,
    vocabulary_rules_applied: null,
    source: 'local',
    html_path: null,
    apple_note_id: null,
    markdown_written_at: null,
    html_written_at: null,
    apple_note_written_at: null,
    truncation_warning: 0,
    estimated_input_tokens: null,
    context_window_at_submit: null,
    processed_externally: 0,
  });

  deps.logger.info(
    { id, kind, originalName, audioPath: dest, durationSeconds, bytes: size },
    'local file imported',
  );

  return { recordingId: id, kind, audioPath: dest, durationSeconds };
}

// ---------------------------------------------------------------------------
// Streaming copy with byte-level progress
// ---------------------------------------------------------------------------

/**
 * Copy `src` to `dest` via streams so we can report byte-level progress
 * on the way through. The previous implementation used `copyFileSync`
 * which is sync (blocks the main thread for the duration of the copy)
 * and gives no progress feedback — fine for small mp3s, painful for
 * a 2-hour wav at 700MB.
 *
 * Progress callbacks are throttled to ~5 per second so we don't spam
 * the renderer with hundreds of pushes for a fast copy on an SSD.
 */
async function streamingCopyWithProgress(
  src: string,
  dest: string,
  onPercent: (percent: number | null) => void,
): Promise<void> {
  const totalBytes = statSync(src).size;
  if (totalBytes === 0) {
    throw new LocalImportError('Source file is empty.');
  }

  let bytesCopied = 0;
  let lastEmitMs = 0;

  return new Promise<void>((resolve, reject) => {
    const reader = createReadStream(src);
    const writer = createWriteStream(dest);

    reader.on('data', (chunk: string | Buffer) => {
      bytesCopied += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      const now = Date.now();
      // Throttle: at most ~5 events per second. The final 100% emit
      // happens unconditionally on 'close' below so the UI always
      // sees the row finish.
      if (now - lastEmitMs >= 200) {
        lastEmitMs = now;
        const percent = Math.min(99, Math.floor((bytesCopied / totalBytes) * 100));
        onPercent(percent);
      }
    });

    reader.on('error', (e) => {
      // Best-effort cleanup so a half-written dest doesn't confuse retry.
      try {
        if (existsSync(dest)) unlinkSync(dest);
      } catch {
        // swallow
      }
      reject(new LocalImportError(`Could not read source: ${e.message}`, e));
    });

    writer.on('error', (e) => {
      try {
        if (existsSync(dest)) unlinkSync(dest);
      } catch {
        // swallow
      }
      reject(new LocalImportError(`Could not write to audio cache: ${e.message}`, e));
    });

    writer.on('close', () => {
      onPercent(100);
      resolve();
    });

    reader.pipe(writer);
  });
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe helpers
// ---------------------------------------------------------------------------

/**
 * Extract the audio track from a video container and write to `dest` as MP3.
 *
 * Requires ffmpeg on PATH. Failure modes:
 *   - ffmpeg not installed     -> clear message with install instructions
 *   - ffmpeg fails (corrupt,
 *     no audio track, etc.)    -> stderr-truncated error surfaced to user
 *   - user cancels             -> leaves no partial file (we unlink on failure)
 *
 * Progress
 * --------
 * ffmpeg writes status lines to stderr looking like:
 *
 *   frame=  123 fps= 45 q=-1.0 size=    1024kB time=00:01:23.45 bitrate=...
 *
 * We parse `time=HH:MM:SS.ss` and divide by `totalDurationSeconds` to
 * get a percent. If the duration probe failed (sourceDuration is null)
 * we emit `null` percents — the UI shows an indeterminate spinner.
 */
async function extractAudioFromVideo(
  src: string,
  dest: string,
  totalDurationSeconds: number | null,
  logger: Logger,
  onPercent: (percent: number | null) => void,
): Promise<void> {
  if (!isOnPath('ffmpeg')) {
    throw new LocalImportError(
      'ffmpeg is not installed, so video files cannot be imported. ' +
        'Install it with: brew install ffmpeg. ' +
        'Audio files (.mp3, .m4a, .wav) can still be imported without ffmpeg.',
    );
  }

  logger.info({ src, dest, totalDurationSeconds }, 'extracting audio from video via ffmpeg');

  // -nostdin       : ffmpeg shouldn't read stdin (we never write to it)
  // -i             : input file
  // -vn            : drop video stream
  // -acodec mp3    : encode audio as MP3 (universally decodable by MLX Whisper)
  // -ab 128k       : 128 kbps is plenty for speech; keeps file small
  // -ar 16000      : 16 kHz sample rate, matches Whisper's internal expectation
  //                  (MLX Whisper will resample otherwise; this saves a step)
  // -progress pipe:2 : machine-parseable progress on stderr alongside the human chatter
  // -y             : overwrite dest without prompting (we manage uniqueness)
  const args = [
    '-nostdin',
    '-i', src,
    '-vn',
    '-acodec', 'mp3',
    '-ab', '128k',
    '-ar', '16000',
    '-y',
    dest,
  ];

  const proc = spawn('ffmpeg', args);
  let stderr = '';
  // Throttle progress emits the same way we do for streaming copy. ffmpeg
  // can spit out a progress line several times a second on a fast machine.
  let lastEmitMs = 0;

  // Initial 0% so the UI shows movement immediately even if ffmpeg
  // takes a moment to produce its first time= line.
  onPercent(totalDurationSeconds !== null ? 0 : null);

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;

    if (totalDurationSeconds === null) return;

    // Parse the most recent time= field in this chunk. Sometimes
    // multiple progress lines arrive in one buffer; take the last.
    const matches = text.matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{1,3})/g);
    let lastSeconds: number | null = null;
    for (const m of matches) {
      const h = parseInt(m[1]!, 10);
      const min = parseInt(m[2]!, 10);
      const s = parseInt(m[3]!, 10);
      const fracStr = m[4]!;
      const frac = parseFloat(`0.${fracStr}`);
      if (Number.isFinite(h) && Number.isFinite(min) && Number.isFinite(s)) {
        lastSeconds = h * 3600 + min * 60 + s + frac;
      }
    }

    if (lastSeconds === null) return;
    const now = Date.now();
    if (now - lastEmitMs < 200) return;
    lastEmitMs = now;

    const percent = Math.min(99, Math.floor((lastSeconds / totalDurationSeconds) * 100));
    onPercent(percent);
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => resolve(code ?? -1));
  });

  if (exitCode !== 0) {
    // Clean up any partial output so retry starts clean.
    if (existsSync(dest)) {
      try { unlinkSync(dest); } catch { /* swallow */ }
    }
    // ffmpeg's stderr is chatty. The useful line is usually near the end.
    const tail = stderr.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
    throw new LocalImportError(
      `ffmpeg failed (exit ${exitCode}):\n${tail || stderr.slice(-500)}`,
    );
  }

  // Final 100% emit so the UI reaches a clean end-state regardless of
  // whether ffmpeg's last time= line was at exactly the duration.
  onPercent(100);
}

/**
 * Probe audio duration in seconds. Returns null if ffprobe isn't available
 * or if it fails — the pipeline works without a known duration, the UI
 * just shows "—" instead of "30m".
 */
function probeDurationSeconds(path: string): number | null {
  if (!isOnPath('ffprobe')) return null;

  const result = spawnSync(
    'ffprobe',
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { encoding: 'utf8' },
  );

  if (result.status !== 0) return null;
  const parsed = parseFloat(result.stdout.trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

/**
 * Check whether an executable is discoverable on PATH. Uses `which` on Unix;
 * we don't target Windows for this app (macOS-only menu bar).
 */
function isOnPath(binary: string): boolean {
  const result = spawnSync('which', [binary], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Return a file's mtime in epoch ms, or null if unavailable. Used as the
 * `start_time` for locally-imported recordings so they sort sensibly in the
 * inbox alongside Plaud recordings.
 */
function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
