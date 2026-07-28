import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appSupportDir } from './paths.js';
import { bundledRequirementsFile } from './bundledResources.js';
import type { Logger } from './logger.js';

export const venvDir = (): string => path.join(appSupportDir(), 'venv');
export const venvPython = (): string => path.join(venvDir(), 'bin', 'python');
export const venvPip = (): string => path.join(venvDir(), 'bin', 'pip');

export type VenvStatus =
  | { kind: 'ready'; pythonPath: string; pythonVersion: string }
  | { kind: 'missing' }
  | { kind: 'broken'; reason: string }
  | { kind: 'wrong-version'; pythonPath: string; foundVersion: string }
  | { kind: 'incomplete'; pythonPath: string; pythonVersion: string };

export type SystemPythonResult =
  | { kind: 'found'; path: string; version: string }
  | { kind: 'not-found'; triedPaths: string[] };

export type InstallationStatus =
  | { kind: 'ready'; pythonPath: string; source: 'user-venv' | 'dev-venv' }
  | { kind: 'python-missing'; venvStatus: VenvStatus; triedPaths: string[] }
  | { kind: 'needs-setup'; venvStatus: VenvStatus; systemPython: string };

export type SetupPhase = 'creating-venv' | 'installing-packages' | 'verifying';

export interface SetupProgressEvent {
  phase: SetupPhase;
  log?: { stream: 'stdout' | 'stderr'; text: string };
}

export type InstallVenvResult =
  | { kind: 'success'; pythonPath: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; phase: SetupPhase; message: string };

export function detectVenv(): VenvStatus {
  const py = venvPython();
  if (!fs.existsSync(py)) {
    return fs.existsSync(venvDir())
      ? { kind: 'broken', reason: `python binary missing at ${py}` }
      : { kind: 'missing' };
  }
  const versionResult = spawnSync(py, ['--version'], { encoding: 'utf-8', timeout: 5000 });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      kind: 'broken',
      reason:
        versionResult.error?.message ??
        `python --version exited ${versionResult.status}: ${versionResult.stderr}`,
    };
  }
  const versionLine = (versionResult.stdout || versionResult.stderr).trim() || 'unknown';
  if (!/^Python 3\.11\./.test(versionLine)) {
    return { kind: 'wrong-version', pythonPath: py, foundVersion: versionLine };
  }
  // Check EVERY package the pipeline needs, not just mlx_whisper.
  //
  // This is the upgrade path: a venv created by an older build has
  // mlx_whisper but not onnxruntime, and if we only tested the former
  // we would report 'ready', skip setup, and leave VAD silently
  // disabled — transcription still works, so nothing looks wrong, but
  // the hallucination suppression and speed-up are quietly absent.
  // Reporting 'incomplete' instead sends the user through the setup
  // window, which pip-installs the current requirements.txt.
  const importResult = spawnSync(py, ['-c', 'import mlx_whisper, onnxruntime'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (importResult.status !== 0) {
    return { kind: 'incomplete', pythonPath: py, pythonVersion: versionLine };
  }
  return { kind: 'ready', pythonPath: py, pythonVersion: versionLine };
}

export function detectSystemPython(): SystemPythonResult {
  const candidates = [
    '/opt/homebrew/bin/python3.11', // Apple Silicon Homebrew
    '/usr/local/bin/python3.11', // Intel Homebrew or python.org installer
    // PATH fallbacks. Won't help much in the packaged-app context
    // but cheap to try and useful in dev.
    'python3.11',
    'python3',
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf-8', timeout: 3000 });
    if (result.error || result.status !== 0) continue;
    const versionLine = (result.stdout || result.stderr).trim() || '';
    if (/^Python 3\.11\./.test(versionLine)) {
      return { kind: 'found', path: candidate, version: versionLine };
    }
  }
  return { kind: 'not-found', triedPaths: candidates };
}

export function getInstallationStatus(devVenvPath: string | null): InstallationStatus {
  const venvStatus = detectVenv();
  if (venvStatus.kind === 'ready') {
    return { kind: 'ready', pythonPath: venvStatus.pythonPath, source: 'user-venv' };
  }
  if (devVenvPath !== null && fs.existsSync(devVenvPath)) {
    return { kind: 'ready', pythonPath: devVenvPath, source: 'dev-venv' };
  }
  const systemPython = detectSystemPython();
  if (systemPython.kind === 'not-found') {
    return { kind: 'python-missing', venvStatus, triedPaths: systemPython.triedPaths };
  }
  return { kind: 'needs-setup', venvStatus, systemPython: systemPython.path };
}

export interface InstallVenvOptions {
  systemPython: string;
  signal?: AbortSignal;
  onProgress: (e: SetupProgressEvent) => void;
  logger?: Logger;
}

export async function installVenv(opts: InstallVenvOptions): Promise<InstallVenvResult> {
  const { systemPython, signal, onProgress, logger } = opts;
  try {
    fs.mkdirSync(path.dirname(venvDir()), { recursive: true });
  } catch (e) {
    return {
      kind: 'failed',
      phase: 'creating-venv',
      message: `Could not create parent directory for venv: ${String(e)}`,
    };
  }

  const venvAlreadyExists = fs.existsSync(venvPython());
  if (!venvAlreadyExists) {
    onProgress({ phase: 'creating-venv' });
    logger?.info({ systemPython, venvDir: venvDir() }, 'creating venv');
    const venvResult = await spawnLineByLine(systemPython, ['-m', 'venv', venvDir()], {
      signal,
      onProgress,
      phase: 'creating-venv',
    });
    if (venvResult.kind === 'cancelled') return { kind: 'cancelled' };
    if (venvResult.kind === 'failed') {
      return { kind: 'failed', phase: 'creating-venv', message: venvResult.message };
    }
  } else {
    logger?.info('venv already exists, skipping creation');
  }

  onProgress({ phase: 'installing-packages' });
  logger?.info({ pip: venvPip(), reqs: bundledRequirementsFile() }, 'installing packages');
  const pipResult = await spawnLineByLine(
    venvPip(),
    ['install', '--no-input', '--disable-pip-version-check', '-r', bundledRequirementsFile()],
    { signal, onProgress, phase: 'installing-packages' },
  );
  if (pipResult.kind === 'cancelled') return { kind: 'cancelled' };
  if (pipResult.kind === 'failed') {
    return { kind: 'failed', phase: 'installing-packages', message: pipResult.message };
  }

  onProgress({ phase: 'verifying' });
  logger?.info('verifying mlx_whisper import');
  const verifyResult = await spawnLineByLine(
    venvPython(),
    ['-c', 'import mlx_whisper, onnxruntime; print("ok")'],
    { signal, onProgress, phase: 'verifying' },
  );
  if (verifyResult.kind === 'cancelled') return { kind: 'cancelled' };
  if (verifyResult.kind === 'failed') {
    return {
      kind: 'failed',
      phase: 'verifying',
      message:
        'Install completed but importing mlx_whisper / onnxruntime still failed. ' +
        verifyResult.message,
    };
  }
  return { kind: 'success', pythonPath: venvPython() };
}

type SpawnResult = { kind: 'ok' } | { kind: 'cancelled' } | { kind: 'failed'; message: string };

/**
 * Spawn a process and forward its output line by line to onProgress —
 * this is what makes the setup window's live log pane work. Keeps the
 * last 50 stderr lines for the failure message.
 */
export async function spawnLineByLine(
  command: string,
  args: string[],
  opts: { signal?: AbortSignal; onProgress: (e: SetupProgressEvent) => void; phase: SetupPhase },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(command, args, { signal: opts.signal });
    } catch (e) {
      resolve({ kind: 'failed', message: `Could not spawn ${command}: ${String(e)}` });
      return;
    }
    let stdoutBuf = '';
    let stderrBuf = '';
    const stderrTail: string[] = [];
    const stderrTailMax = 50;
    const flushLine = (stream: 'stdout' | 'stderr', text: string) => {
      const trimmed = text.replace(/\r/g, '');
      if (trimmed.length === 0) return;
      opts.onProgress({ phase: opts.phase, log: { stream, text: trimmed } });
      if (stream === 'stderr') {
        stderrTail.push(trimmed);
        if (stderrTail.length > stderrTailMax) stderrTail.shift();
      }
    };
    const handleChunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
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
    proc.once('error', (err) => {
      if (err.name === 'AbortError') {
        resolve({ kind: 'cancelled' });
      } else {
        resolve({ kind: 'failed', message: err.message });
      }
    });
    proc.once('close', (code) => {
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
          message: `Process exited with code ${code}. Last stderr lines: ${stderrTail.join(' | ').slice(-1500)}`,
        });
      }
    });
  });
}
