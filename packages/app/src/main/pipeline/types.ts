/**
 * Shared types for the pipeline module.
 */

import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import type { State } from '../state.js';
import type { OllamaClient } from '../ollama.js';
import type { PlaudClient } from '@plaud/core';

export interface PipelineContext {
  state: State;
  /**
   * Live config accessor. Must be a getter (not a captured value) so the
   * pipeline picks up Settings changes between steps without a restart.
   * A previous shape passed `cfg: AppConfig` by value, which meant the
   * worker read the startup snapshot forever — Settings edits to output
   * destinations / Ollama host / Whisper model only took effect after
   * relaunching the app. Using a getter here is the single-line fix.
   */
  getConfig: () => AppConfig;
  logger: Logger;
  ollama: OllamaClient;
  plaud: PlaudClient;
  /**
   * Absolute path to the app package on disk. Used to resolve the
   * bundled Python virtualenv and `transcribe.py` script regardless of
   * what cwd Electron was launched from.
   */
  packageDir: string;
  /**
   * Absolute path to the user's app-support directory (where state.db,
   * config.json, and the user's venv live). Passed to prettifyError so
   * path-related error messages name the actual directory rather than
   * a generic ~/Library/Application Support/distill placeholder.
   */
  appSupportDir: string;
  /**
   * True iff this is a packaged build (.app from /Applications) rather
   * than `npm run dev`. Routes prettifyError remediation between
   * dev-style ("cd packages/app/python && uv pip install") and
   * packaged-style ("delete <appSupportDir>/venv and re-launch"). Set
   * once at construction from `app.isPackaged`.
   */
  isPackaged: boolean;
}

/**
 * Thrown when a step is aborted by user cancellation. The worker catches
 * these silently (they're expected) rather than marking the recording
 * as `error`. The state row itself is moved to `cancelled` by the caller
 * that initiated the cancel.
 */
export class CancelledError extends Error {
  constructor(step: string) {
    super(`Step '${step}' cancelled`);
    this.name = 'CancelledError';
  }
}

export function isCancelled(e: unknown): e is CancelledError {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError');
}
