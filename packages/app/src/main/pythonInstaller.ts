/**
 * Python venv installer.
 *
 * The active half of the first-launch setup flow. `pythonSetup.ts`
 * handles detection (where the venv lives, whether it's usable, where
 * to find a system Python). This module handles creation:
 *
 *   1. `python3.11 -m venv <venvDir>`
 *   2. `<venvDir>/bin/pip install -r requirements.txt`
 *
 * Both steps stream their stdout/stderr through callbacks so the
 * setup window can show live progress. The whole thing is wrapped in
 * a single `installVenv()` async function that the IPC handler
 * invokes — kept top-level (no class, no instance state) because at
 * any moment there's at most one install running per app process.
 *
 * Failure modes that get reported to the caller:
 *
 *   - venv creation fails: probably system Python is broken or
 *     out of disk. Returned with the python stderr included.
 *   - pip install fails: probably network drop, missing wheel for
 *     the system Python's exact version, or PyPI hiccup. Same
 *     shape — stderr in the message.
 *   - install was cancelled: the AbortSignal's reason. Setup window
 *     can use this to show "Cancelled" rather than "Failed".
 *
 * Cleanup: a half-created venv is deliberately NOT removed on
 * failure. `detectVenv` reports `incomplete` for that state, and
 * the next install attempt re-runs pip without re-creating the venv,
 * so a partially-downloaded pip cache can be reused. Ditching the
 * venv on every failure would force a full re-download of the
 * Python interpreter copy (~30MB) plus a fresh pip cache miss on
 * every retry, which is unfriendly on slow connections.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import { bundledRequirementsFile } from './bundledResources.js';
import { venvDir, venvPip, venvPython } from './pythonSetup.js';

/**
 * Phase of the install. Reported through onProgress so the setup
 * window can render the right label and progress bar segment.
 *
 *   - 'creating-venv': running `python3.11 -m venv`. Fast (~5s).
 *   - 'installing-packages': running pip install. Slow (2-5min;
 *     ~700MB of wheels for mlx-whisper and friends).
 *   - 'verifying': spawning the new venv's python with
 *     `import mlx_whisper` to confirm it landed.
 */
export type InstallPhase =
  | 'creating-venv'
  | 'installing-packages'
  | 'verifying';

/**
 * One streamed line of output from the install. Setup window
 * appends these to the log textarea so the user can see what's
 * happening.
 */
export interface InstallLogLine {
  /** Where the line came from. stderr lines are styled differently. */
  stream: 'stdout' | 'stderr';
  /** The line itself, no trailing newline. */
  text: string;
}

/**
 * Progress event. Emitted at phase transitions and periodically
 * during pip install (whenever a new line of output arrives). The
 * setup UI uses `phase` for the progress bar segment and `log` for
 * the streaming output.
 */
export interface InstallProgress {
  phase: InstallPhase;
  /**
   * Optional log line. Present on output events; absent on the
   * initial phase-transition pings so the renderer can switch
   * labels even before the spawned process starts producing
   * output.
   */
  log?: InstallLogLine;
}

export type InstallResult =
  | { kind: 'success'; pythonPath: string }
  | { kind: 'failed'; phase: InstallPhase; message: string }
  | { kind: 'cancelled' };

interface InstallOptions {
  systemPython: string;
  signal?: AbortSignal;
  onProgress: (event: InstallProgress) => void;
  logger?: Logger;
}

/**
 * Run the full install: venv creation + pip install. Sequential —
 * no parallelism would help (pip needs the venv done first) and the
 * sequential shape is far easier to reason about for cancellation
 * and progress reporting.
 *
 * Idempotent in the sense that if the venv already exists,
 * `python -m venv` is a no-op (it won't overwrite). pip install
 * with `-r requirements.txt` re-resolves the requirements every
 * time but cache hits in `~/Library/Caches/pip/` make repeats
 * cheap — typically 5-15s on a re-run.
 */
export async function installVenv(opts: InstallOptions): Promise<InstallResult> {
  const { systemPython, signal, onProgress, logger } = opts;

  // Make sure the parent dir exists. appSupportDir() should already
  // exist by this point (state.db lives there) but we don't assume.
  try {
    mkdirSync(dirname(venvDir()), { recursive: true });
  } catch (e) {
    return {
      kind: 'failed',
      phase: 'creating-venv',
      message: `Could not create parent directory for venv: ${String(e)}`,
    };
  }

  // ---- Phase 1: create the venv ------------------------------------------

  // Skip venv creation if it already exists (e.g. retry after a
  // pip-install failure). detectVenv() returning 'incomplete' is the
  // canonical trigger for this branch.
  const venvAlreadyExists = existsSync(venvPython());

  if (!venvAlreadyExists) {
    onProgress({ phase: 'creating-venv' });
    logger?.info({ systemPython, venvDir: venvDir() }, 'creating venv');

    const venvResult = await spawnLineByLine(
      systemPython,
      ['-m', 'venv', venvDir()],
      { signal, onProgress, phase: 'creating-venv' },
    );
    if (venvResult.kind === 'cancelled') return { kind: 'cancelled' };
    if (venvResult.kind === 'failed') {
      return {
        kind: 'failed',
        phase: 'creating-venv',
        message: venvResult.message,
      };
    }
  } else {
    logger?.info('venv already exists, skipping creation');
  }

  // ---- Phase 2: pip install ----------------------------------------------

  onProgress({ phase: 'installing-packages' });
  logger?.info(
    { pip: venvPip(), reqs: bundledRequirementsFile() },
    'installing packages',
  );

  // --no-input: never prompt for keyring credentials (this is
  // a non-interactive subprocess; a prompt would deadlock).
  // --disable-pip-version-check: don't waste a line on the
  // "newer pip available" notice.
  const pipResult = await spawnLineByLine(
    venvPip(),
    [
      'install',
      '--no-input',
      '--disable-pip-version-check',
      '-r',
      bundledRequirementsFile(),
    ],
    { signal, onProgress, phase: 'installing-packages' },
  );
  if (pipResult.kind === 'cancelled') return { kind: 'cancelled' };
  if (pipResult.kind === 'failed') {
    return {
      kind: 'failed',
      phase: 'installing-packages',
      message: pipResult.message,
    };
  }

  // ---- Phase 3: verify ---------------------------------------------------

  onProgress({ phase: 'verifying' });
  logger?.info('verifying mlx_whisper import');

  const verifyResult = await spawnLineByLine(
    venvPython(),
    ['-c', 'import mlx_whisper; print("ok")'],
    { signal, onProgress, phase: 'verifying' },
  );
  if (verifyResult.kind === 'cancelled') return { kind: 'cancelled' };
  if (verifyResult.kind === 'failed') {
    return {
      kind: 'failed',
      phase: 'verifying',
      message:
        'Install completed but `import mlx_whisper` still failed. ' +
        verifyResult.message,
    };
  }

  return { kind: 'success', pythonPath: venvPython() };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface SpawnOptions {
  signal?: AbortSignal;
  onProgress: (event: InstallProgress) => void;
  phase: InstallPhase;
}

type SpawnResult =
  | { kind: 'ok' }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

/**
 * Spawn a process and stream its stdout/stderr line-by-line through
 * `onProgress`. Resolves when the process exits.
 *
 * Buffering: child processes can emit partial lines (a chunk that
 * straddles a `\n`). We accumulate per-stream and only emit a
 * progress event on a complete line. Final partial-buffer flush on
 * close so the very last line isn't lost if it doesn't end with `\n`.
 */
async function spawnLineByLine(
  command: string,
  args: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { signal: opts.signal });
    } catch (e) {
      resolve({
        kind: 'failed',
        message: `Could not spawn ${command}: ${String(e)}`,
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    // Keep the tail of stderr so we can include it in the failure
    // message if the exit code is non-zero. ~2KB is enough to capture
    // a useful pip/python error without dumping the whole log into
    // the message field.
    const stderrTail: string[] = [];
    const stderrTailMax = 50; // lines

    const flushLine = (
      stream: 'stdout' | 'stderr',
      text: string,
    ): void => {
      // The stream may emit \r-only "carriage return" updates from
      // pip's progress bars. Drop empty / whitespace-only lines so
      // the log doesn't fill up with noise.
      const trimmed = text.replace(/\r/g, '');
      if (trimmed.length === 0) return;
      opts.onProgress({
        phase: opts.phase,
        log: { stream, text: trimmed },
      });
      if (stream === 'stderr') {
        stderrTail.push(trimmed);
        if (stderrTail.length > stderrTailMax) stderrTail.shift();
      }
    };

    const handleChunk = (
      stream: 'stdout' | 'stderr',
      buf: Buffer,
    ): void => {
      const text = buf.toString('utf8');
      let bufRef = stream === 'stdout' ? stdoutBuf : stderrBuf;
      bufRef += text;
      let nl = bufRef.indexOf('\n');
      while (nl !== -1) {
        flushLine(stream, bufRef.slice(0, nl));
        bufRef = bufRef.slice(nl + 1);
        nl = bufRef.indexOf('\n');
      }
      if (stream === 'stdout') stdoutBuf = bufRef;
      else stderrBuf = bufRef;
    };

    proc.stdout?.on('data', (chunk: Buffer) => handleChunk('stdout', chunk));
    proc.stderr?.on('data', (chunk: Buffer) => handleChunk('stderr', chunk));

    proc.once('error', (err: NodeJS.ErrnoException) => {
      // Most relevant: AbortError (signal aborted) or ENOENT (binary
      // missing). The signal-abort case is reported as cancelled so
      // the setup UI distinguishes it from a real failure.
      if (err.name === 'AbortError') {
        resolve({ kind: 'cancelled' });
      } else {
        resolve({ kind: 'failed', message: err.message });
      }
    });

    proc.once('close', (code) => {
      // Flush trailing partial lines (pip's last status often has
      // no terminal newline).
      if (stdoutBuf.length > 0) flushLine('stdout', stdoutBuf);
      if (stderrBuf.length > 0) flushLine('stderr', stderrBuf);

      if (opts.signal?.aborted) {
        resolve({ kind: 'cancelled' });
        return;
      }
      if (code === 0) {
        resolve({ kind: 'ok' });
      } else {
        resolve({
          kind: 'failed',
          message:
            `Process exited with code ${code}. ` +
            `Last stderr lines: ${stderrTail.join(' | ').slice(-1500)}`,
        });
      }
    });
  });
}
