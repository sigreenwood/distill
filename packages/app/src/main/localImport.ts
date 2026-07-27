import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { audioDir } from './paths.js';
import type { Logger } from './logger.js';
import type { State } from './state.js';

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac', '.opus']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm']);

export type LocalImportKind = 'audio-passthrough' | 'video-extract-audio' | 'unsupported';

export type LocalImportPhase = 'probe' | 'copy' | 'extract' | 'finalise';

export interface LocalImportProgress {
  sourcePath: string;
  phase: LocalImportPhase;
  percent: number | null;
}

export interface LocalImportDeps {
  state: State;
  logger: Logger;
  onProgress?: (p: LocalImportProgress) => void;
}

export interface LocalImportResult {
  recordingId: string;
  kind: LocalImportKind;
  audioPath: string;
  durationSeconds: number | null;
}

export class LocalImportError extends Error {
  userMessage: string;

  constructor(userMessage: string, cause?: unknown) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = 'LocalImportError';
    if (cause instanceof Error) this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
  }
}

export function classifyPath(p: string): LocalImportKind {
  const ext = path.extname(p).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return 'audio-passthrough';
  if (VIDEO_EXTS.has(ext)) return 'video-extract-audio';
  return 'unsupported';
}

export async function importLocalFile(
  srcPath: string,
  deps: LocalImportDeps,
): Promise<LocalImportResult> {
  if (!fs.existsSync(srcPath)) {
    throw new LocalImportError(`File not found: ${srcPath}`);
  }
  const kind = classifyPath(srcPath);
  if (kind === 'unsupported') {
    throw new LocalImportError(
      `Unsupported file type: ${path.extname(srcPath) || '(no extension)'}. Accepted formats: ${[...AUDIO_EXTS, ...VIDEO_EXTS].sort().join(', ')}.`,
    );
  }
  const dir = audioDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = `local-${crypto.randomUUID().slice(0, 12)}`;
  const originalName = path.basename(srcPath);
  const dest = path.join(dir, `${id}.mp3`);

  const emit = (phase: LocalImportPhase, percent: number | null) => {
    if (!deps.onProgress) return;
    try {
      deps.onProgress({ sourcePath: srcPath, phase, percent });
    } catch (e) {
      deps.logger.warn({ err: String(e) }, 'progress callback threw — ignoring');
    }
  };

  emit('probe', null);
  const sourceDuration = probeDurationSeconds(srcPath);

  if (kind === 'audio-passthrough') {
    deps.logger.info({ src: srcPath, dest, originalName }, 'copying local audio');
    await streamingCopyWithProgress(srcPath, dest, (percent) => emit('copy', percent));
  } else {
    await extractAudioFromVideo(srcPath, dest, sourceDuration, deps.logger, (percent) =>
      emit('extract', percent),
    );
  }

  const size = fs.statSync(dest).size;
  if (size === 0) {
    fs.unlinkSync(dest);
    throw new LocalImportError('Resulting audio file is empty.');
  }

  emit('finalise', null);
  const durationSeconds =
    kind === 'audio-passthrough' && sourceDuration !== null
      ? sourceDuration
      : probeDurationSeconds(dest);

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

async function streamingCopyWithProgress(
  src: string,
  dest: string,
  onPercent: (percent: number) => void,
): Promise<void> {
  const totalBytes = fs.statSync(src).size;
  if (totalBytes === 0) {
    throw new LocalImportError('Source file is empty.');
  }
  let bytesCopied = 0;
  let lastEmitMs = 0;
  return new Promise((resolve, reject) => {
    const reader = fs.createReadStream(src);
    const writer = fs.createWriteStream(dest);
    reader.on('data', (chunk) => {
      bytesCopied += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      const now = Date.now();
      if (now - lastEmitMs >= 200) {
        lastEmitMs = now;
        const percent = Math.min(99, Math.floor((bytesCopied / totalBytes) * 100));
        onPercent(percent);
      }
    });
    reader.on('error', (e) => {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        // best-effort cleanup
      }
      reject(new LocalImportError(`Could not read source: ${e.message}`, e));
    });
    writer.on('error', (e) => {
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      } catch {
        // best-effort cleanup
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

async function extractAudioFromVideo(
  src: string,
  dest: string,
  totalDurationSeconds: number | null,
  logger: Logger,
  onPercent: (percent: number | null) => void,
): Promise<void> {
  if (!isOnPath('ffmpeg')) {
    throw new LocalImportError(
      'ffmpeg is not installed, so video files cannot be imported. Install it with: brew install ffmpeg. Audio files (.mp3, .m4a, .wav) can still be imported without ffmpeg.',
    );
  }
  logger.info({ src, dest, totalDurationSeconds }, 'extracting audio from video via ffmpeg');
  const args = ['-nostdin', '-i', src, '-vn', '-acodec', 'mp3', '-ab', '128k', '-ar', '16000', '-y', dest];
  const proc = spawn('ffmpeg', args);
  let stderr = '';
  let lastEmitMs = 0;
  onPercent(totalDurationSeconds !== null ? 0 : null);
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (totalDurationSeconds === null) return;
    // ffmpeg writes progress lines like "time=00:01:23.45" to stderr
    const matches = text.matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{1,3})/g);
    let lastSeconds: number | null = null;
    for (const m of matches) {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const s = parseInt(m[3], 10);
      const frac = parseFloat(`0.${m[4]}`);
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
  const exitCode = await new Promise<number>((resolve, reject) => {
    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // best-effort cleanup
      }
    }
    const tail = stderr
      .split('\n')
      .filter((l) => l.trim())
      .slice(-8)
      .join('\n');
    throw new LocalImportError(`ffmpeg failed (exit ${exitCode}):\n${tail || stderr.slice(-500)}`);
  }
  onPercent(100);
}

export function probeDurationSeconds(p: string): number | null {
  if (!isOnPath('ffprobe')) return null;
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', p],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  const parsed = parseFloat(result.stdout.trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function isOnPath(binary: string): boolean {
  const result = spawnSync('which', [binary], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function fileMtime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}
