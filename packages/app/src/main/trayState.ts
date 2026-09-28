/**
 * Tray state derivation — pure logic, no Electron dependency.
 *
 * Kept separate from tray.ts so the test suite can import it without
 * loading Electron (which would fail in a plain Node/vitest process).
 *
 * The state derived here drives the tray icon colour: green when
 * processing, amber when paused, red when errors are outstanding,
 * template-monochrome when idle. See tray.ts for rendering.
 */

export type TrayState = 'idle' | 'processing' | 'paused' | 'error';

export interface TrayStateInputs {
  /** True when at least one recording is in a pipeline-running status. */
  processingRunning: boolean;
  /** cfg.paused — the user has paused polling / worker intake. */
  paused: boolean;
  /** Number of recordings in status='error'. */
  errorCount: number;
}

/**
 * Priority order: processing > paused > error > idle.
 *
 * Rationale: the tray colour reflects what's happening now. A live-work
 * signal (green) should win over a stale warning (red) — if the pipeline
 * is actively making progress, red would wrongly suggest something is
 * broken. Errors stay surfaced via the ⚠ glyph in the title text, so
 * they're never hidden, just de-prioritised from the icon colour.
 *
 * Paused beats error because "paused" is intentional user state; if the
 * user has paused, they know the app isn't trying to do work, and a red
 * icon would wrongly imply they need to fix something.
 */
export function computeTrayState(inputs: TrayStateInputs): TrayState {
  if (inputs.processingRunning) return 'processing';
  if (inputs.paused) return 'paused';
  if (inputs.errorCount > 0) return 'error';
  return 'idle';
}
