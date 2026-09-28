/**
 * Bundled-resource path helper.
 *
 * distill ships some files alongside the JS bundle (vocabulary JSON,
 * PROMPTS.md seed data, the transcribe.py script, the bundled config
 * example). They live in two different places depending on whether
 * we're in dev or in a packaged build:
 *
 *   - Dev (electron-vite dev): resources live in the source tree at
 *     <packageDir>/resources/ and <packageDir>/python/. packageDir is
 *     `packages/app` resolved from `app.getAppPath()`.
 *
 *   - Packaged (.pkg → /Applications/distill.app): app.getAppPath()
 *     returns the path to app.asar. The resources bundled via
 *     extraResources in electron-builder.yml land at
 *     process.resourcesPath (i.e. .../distill.app/Contents/Resources/).
 *     So `python/transcribe.py` is at
 *     `<process.resourcesPath>/python/transcribe.py` and not inside
 *     app.asar.
 *
 * The helper centralises that fork so callers don't have to know
 * which branch they're in. Resolves once at module load (the dev/
 * packaged distinction can't change at runtime).
 *
 * IMPORTANT: this is only for files we ship in the bundle. User
 * data (config.json, state.db, the per-user Python venv) lives at
 * `paths.ts::appSupportDir()` and NOT here.
 */

import { app } from 'electron';
import { join } from 'node:path';

/**
 * Absolute path to the directory that contains bundled `resources/`
 * and `python/` subdirectories. Same shape in dev and packaged builds:
 * always has `python/transcribe.py`, `resources/vocabulary/*.json`,
 * etc. relative to it.
 *
 * Resolved lazily on first call, then cached for the life of the
 * process. Lazy because `app.isPackaged` and `process.resourcesPath`
 * aren't reliable until Electron's `app` is ready, and module-load-
 * time evaluation crashes test runners that don't have an Electron
 * app context (e.g. vitest importing a transitive dep of
 * pipeline/steps.ts). Test code that doesn't actually call any
 * bundled* helper never trips the resolver.
 */
function resolveBundledRoot(): string {
  if (app.isPackaged) {
    // process.resourcesPath is .../distill.app/Contents/Resources.
    // Files copied via extraResources land directly under it.
    return process.resourcesPath;
  }
  // Dev: app.getAppPath() returns packages/app/, the source tree.
  // resources/ and python/ live at the root of that.
  return app.getAppPath();
}

let bundledRootCache: string | null = null;
function bundledRoot(): string {
  if (bundledRootCache === null) bundledRootCache = resolveBundledRoot();
  return bundledRootCache;
}

/**
 * Where bundled resources live. Same in dev and packaged.
 *   - <bundledRoot>/resources/vocabulary/*.json
 *   - <bundledRoot>/resources/PROMPTS.md
 *   - <bundledRoot>/resources/example.config.json
 *   - <bundledRoot>/resources/tray-icons/*
 *   - <bundledRoot>/python/transcribe.py
 *   - <bundledRoot>/python/requirements.txt
 */
export const bundledResourcesDir = (): string =>
  join(bundledRoot(), 'resources');

export const bundledPythonDir = (): string => join(bundledRoot(), 'python');

export const bundledTranscribeScript = (): string =>
  join(bundledRoot(), 'python', 'transcribe.py');

export const bundledRequirementsFile = (): string =>
  join(bundledRoot(), 'python', 'requirements.txt');

/**
 * Test-only escape hatch: re-resolve on next call. Not exported via
 * an index file. Production code never needs it because the dev/
 * packaged distinction can't change at runtime within a single
 * process.
 */
export function _resetBundledRootForTests(): void {
  bundledRootCache = null;
}
