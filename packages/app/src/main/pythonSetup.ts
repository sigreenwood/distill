/**
 * Python venv detection and setup helpers.
 *
 * distill ships WITHOUT a Python venv (per the packaging plan: a venv
 * with mlx-whisper is ~840MB of M-machine-specific symlinks; bundling
 * it isn't viable). Each user gets their own venv created at first
 * launch in `~/Library/Application Support/distill/venv/` (or the
 * legacy `Plaud Local/venv/` if that's where the user's appSupportDir
 * resolved to).
 *
 * This module is the pure-logic half of that flow:
 *
 *   - Where the venv lives (`venvDir`, `venvPython`).
 *   - Whether a usable venv exists right now (`detectVenv`).
 *   - Whether a system Python 3.11 is installed and where
 *     (`detectSystemPython`).
 *
 * The actual venv creation (running `python3.11 -m venv`, then
 * `pip install`) and the setup-window UI live in a separate module
 * (commits 3+ in the packaging arc). Keeping detection pure here
 * means it's testable without spawning processes in the test runner.
 *
 * What "usable" means here:
 *
 *   - `<venvDir>/bin/python` exists as a regular file or symlink that
 *     resolves.
 *   - That binary, run with `--version`, exits 0 and prints something
 *     starting with `Python 3.11.`. Other 3.x versions are rejected
 *     deliberately because mlx-whisper's wheels are pinned to 3.11.
 *   - The binary can `import mlx_whisper` without error.
 *
 * Failure modes are reported as a tagged `VenvStatus` so callers can
 * render the right message without parsing exception text.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appSupportDir } from './paths.js';

/**
 * The user's per-install venv directory. Lives under
 * appSupportDir() so it's tied to the same data store as the
 * SQLite db and config. NOT bundled in the app — created at first
 * launch.
 */
export const venvDir = (): string => join(appSupportDir(), 'venv');

/**
 * The Python interpreter inside the user's venv. May not exist
 * yet if the venv hasn't been created.
 */
export const venvPython = (): string => join(venvDir(), 'bin', 'python');

/**
 * The pip wrapper inside the user's venv. Used at venv-creation
 * time to install requirements. Same caveat: may not exist yet.
 */
export const venvPip = (): string => join(venvDir(), 'bin', 'pip');

// ---------------------------------------------------------------------------
// Venv detection
// ---------------------------------------------------------------------------

/**
 * Status of the user's local venv. Exhaustive — every reachable
 * state is named so callers can render the right message rather than
 * parsing exception text.
 */
export type VenvStatus =
  /** Venv exists and is fully usable. */
  | { kind: 'ready'; pythonPath: string; pythonVersion: string }
  /**
   * Venv directory doesn't exist yet. Normal first-launch state.
   * Setup flow should create it.
   */
  | { kind: 'missing' }
  /**
   * Venv directory exists but the python binary is gone or broken
   * (e.g. user deleted bits of it, or the symlink target moved).
   * Setup flow should rebuild it.
   */
  | { kind: 'broken'; reason: string }
  /**
   * Venv exists and python runs, but it's the wrong major.minor
   * version. mlx-whisper wheels are 3.11-only. User probably
   * pointed setup at the wrong system Python.
   */
  | { kind: 'wrong-version'; pythonPath: string; foundVersion: string }
  /**
   * Venv exists, python is the right version, but `import mlx_whisper`
   * failed. Probably means pip install never finished or got
   * interrupted. Setup flow should re-run pip.
   */
  | { kind: 'incomplete'; pythonPath: string; pythonVersion: string };

/**
 * Inspect the venv path and report its status. Pure I/O —
 * filesystem stat + a couple of subprocess spawns. Doesn't modify
 * anything.
 *
 * Spawn calls use `spawnSync` because this is called once at app
 * startup before the UI is up; latency isn't a concern (~50ms total)
 * and it's much simpler to write than chained promises.
 */
export function detectVenv(): VenvStatus {
  const py = venvPython();

  // existsSync follows symlinks. A dangling symlink reports false
  // here, which is the right answer — we want to treat
  // "symlink-to-nothing" the same as "binary missing".
  if (!existsSync(py)) {
    // Differentiate "venv dir doesn't exist at all" from "dir exists
    // but binary is gone" so the setup flow can pick the right
    // user-facing wording.
    return existsSync(venvDir())
      ? { kind: 'broken', reason: `python binary missing at ${py}` }
      : { kind: 'missing' };
  }

  // Step 1: confirm the binary runs and is the right version.
  const versionResult = spawnSync(py, ['--version'], {
    encoding: 'utf-8',
    timeout: 5000,
  });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      kind: 'broken',
      reason:
        versionResult.error?.message ??
        `python --version exited ${versionResult.status}: ${versionResult.stderr}`,
    };
  }
  const versionLine =
    (versionResult.stdout || versionResult.stderr).trim() || 'unknown';
  if (!/^Python 3\.11\./.test(versionLine)) {
    return {
      kind: 'wrong-version',
      pythonPath: py,
      foundVersion: versionLine,
    };
  }

  // Step 2: confirm mlx_whisper imports. This is the canonical "is
  // pip install done?" check. If pip was interrupted mid-flight the
  // venv looks shaped right but imports fail.
  const importResult = spawnSync(py, ['-c', 'import mlx_whisper'], {
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (importResult.status !== 0) {
    return { kind: 'incomplete', pythonPath: py, pythonVersion: versionLine };
  }

  return { kind: 'ready', pythonPath: py, pythonVersion: versionLine };
}

// ---------------------------------------------------------------------------
// System Python detection (used only when the venv is missing)
// ---------------------------------------------------------------------------

export type SystemPythonStatus =
  | { kind: 'found'; path: string; version: string }
  | { kind: 'not-found'; triedPaths: string[] };

/**
 * Search common locations for a Python 3.11 install we can use to
 * bootstrap the venv. Order matters — Homebrew first because it's
 * the recommended install path on Apple Silicon, then /usr/local for
 * older Homebrew or python.org installs, then the PATH fallbacks.
 *
 * Only Python 3.11.x counts as found. mlx-whisper publishes wheels
 * for 3.11 specifically; 3.12 / 3.13 either lack wheels or have
 * compatibility issues that aren't worth surprising the user with.
 *
 * Returns a tagged result so the setup UI can either proceed (kind
 * 'found') or render the brew-install instructions (kind 'not-found',
 * with `triedPaths` for the diagnostic readout).
 */
export function detectSystemPython(): SystemPythonStatus {
  // Try the canonical absolute paths first. We deliberately don't
  // fall back to bare `python3.11` / `python3` on PATH for the
  // packaged-app case — the .app bundle's PATH is reduced compared
  // to a terminal shell, so a user who has Python in /opt/homebrew
  // (the default Apple Silicon Homebrew location) won't have it on
  // their .app PATH unless something explicitly added it. Going
  // straight to absolute paths avoids that footgun.
  const candidates = [
    '/opt/homebrew/bin/python3.11', // Apple Silicon Homebrew
    '/usr/local/bin/python3.11',     // Intel Homebrew or python.org installer
    // PATH fallbacks. Won't help much in the packaged-app context
    // but cheap to try and useful in dev.
    'python3.11',
    'python3',
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (result.error || result.status !== 0) continue;
    const versionLine =
      (result.stdout || result.stderr).trim() || '';
    if (/^Python 3\.11\./.test(versionLine)) {
      return { kind: 'found', path: candidate, version: versionLine };
    }
    // Wrong version on this candidate — move on. Don't return
    // wrong-version here because the next candidate might be 3.11.
  }

  return { kind: 'not-found', triedPaths: candidates };
}

// ---------------------------------------------------------------------------
// Startup-gate decision
// ---------------------------------------------------------------------------

/**
 * The single question the bootstrap code in `index.ts` cares about:
 * "do I need to run the setup flow before starting the app?"
 *
 * Three possible answers:
 *
 *   - `ready`: some usable Python venv exists (user-installed OR a
 *     dev-tree venv at packages/app/python/.venv on a contributor's
 *     machine). Skip setup; proceed to the main app.
 *
 *   - `needs-setup`: user venv is missing/broken/incomplete AND
 *     there's no dev venv to fall back on. Open the setup window.
 *     A system Python 3.11 was found and can be used to bootstrap;
 *     `systemPython` carries its absolute path.
 *
 *   - `python-missing`: same as `needs-setup` but the user doesn't
 *     have Python 3.11 installed at all. Setup window shows the
 *     brew-install instructions and a Quit button — the user can't
 *     proceed until they install Python.
 *
 * The dev-venv fallback is what makes `npm run dev` work without
 * forcing a contributor through the setup flow on their machine.
 * In a packaged build the dev venv path doesn't exist, so the only
 * `ready` path is via the user-installed venv.
 */
export type InstallationStatus =
  | { kind: 'ready'; pythonPath: string; source: 'user-venv' | 'dev-venv' }
  | { kind: 'needs-setup'; venvStatus: VenvStatus; systemPython: string }
  | { kind: 'python-missing'; venvStatus: VenvStatus; triedPaths: string[] };

/**
 * Make the startup-gate decision. Combines `detectVenv` (user-installed
 * venv at appSupportDir/venv) with a dev-tree fallback check
 * (packages/app/python/.venv).
 *
 * `devVenvPath` is passed in rather than computed here because this
 * module deliberately doesn't know about packageDir / app.getAppPath
 * — keeps it free of any electron import so it can be unit-tested
 * with plain Node.
 */
export function getInstallationStatus(
  devVenvPath: string | null,
): InstallationStatus {
  const venvStatus = detectVenv();

  // Happy path: user venv is fully usable.
  if (venvStatus.kind === 'ready') {
    return {
      kind: 'ready',
      pythonPath: venvStatus.pythonPath,
      source: 'user-venv',
    };
  }

  // Dev fallback: user venv isn't ready but the dev tree has one.
  // We don't deeply verify the dev venv here — if it's broken,
  // resolvePythonBinary in steps.ts will surface the real error
  // when transcription runs. The point of this check is to NOT
  // force a contributor through setup just because their
  // appSupportDir/venv doesn't exist.
  if (devVenvPath !== null && existsSync(devVenvPath)) {
    return { kind: 'ready', pythonPath: devVenvPath, source: 'dev-venv' };
  }

  // Setup needed. What kind?
  const systemPython = detectSystemPython();
  if (systemPython.kind === 'not-found') {
    return {
      kind: 'python-missing',
      venvStatus,
      triedPaths: systemPython.triedPaths,
    };
  }
  return { kind: 'needs-setup', venvStatus, systemPython: systemPython.path };
}
