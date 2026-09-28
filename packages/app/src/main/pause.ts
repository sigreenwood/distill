/**
 * Pause configuration - pure logic, no Electron dependency.
 *
 * distill supports both a master pause ("All processing") and four
 * per-step pauses (polling, download, transcribe, summarise). Real-world
 * scenarios that motivated the per-step granularity:
 *
 *   - Mobile hotspot / hotel WiFi: pause downloads, let transcription
 *     and summarisation keep running on already-downloaded audio.
 *   - Heavy CPU work elsewhere (rendering, big build, Teams call):
 *     pause transcription (Whisper saturates CPU). Downloads and
 *     summarise remain fine.
 *   - Ollama deliberately unavailable (model swap, GPU memory needed
 *     elsewhere): pause summarisation only.
 *
 * The write step is intentionally NOT pausable. By the time a row
 * reaches write, the expensive work is done; finishing the write
 * promptly is what the user wants.
 *
 * See BACKLOG.md "Pause controls - global and per-step" for the spec.
 */

/**
 * The four pausable pipeline steps. Mirrors the four phases the worker
 * walks through, minus `write` (never pausable).
 *
 * `polling` is here for symmetry even though strictly speaking it isn't
 * a pipeline step: it's the Plaud cloud poller. Treating it the same
 * way means the tray submenu, config shape, and back-compat shim all
 * stay uniform.
 */
export type PausableStep = 'polling' | 'download' | 'transcribe' | 'summarise';

export const PAUSABLE_STEPS: readonly PausableStep[] = [
  'polling',
  'download',
  'transcribe',
  'summarise',
];

/**
 * The on-disk pause shape. Stored under `paused` in config.json.
 *
 * `all` is the master switch: when true, every step is treated as
 * paused regardless of the per-step flags. Keeping the per-step flags
 * around even when `all` is on means the user can flip the master off
 * and have their per-step preferences come back unchanged.
 */
export interface PauseConfig {
  all: boolean;
  polling: boolean;
  download: boolean;
  transcribe: boolean;
  summarise: boolean;
}

/**
 * Default: nothing paused. Used as the seed for new installs and as
 * the merge target when normalising a partial / malformed config.
 */
export function defaultPauseConfig(): PauseConfig {
  return {
    all: false,
    polling: false,
    download: false,
    transcribe: false,
    summarise: false,
  };
}

/**
 * Normalise an arbitrary `paused` field from config.json into a
 * fully-shaped PauseConfig.
 *
 * Accepted inputs:
 *   - undefined / null: defaults (nothing paused).
 *   - `true` (legacy): `{ all: true, ...false }` per BACKLOG's
 *     back-compat note. Treated as the user wanting everything off.
 *   - `false` (legacy): defaults.
 *   - object: fields read individually, missing fields default false.
 *     Unknown fields are dropped silently rather than rejected. This
 *     is config, not API input, and tolerance is friendlier than
 *     loud errors on a hand-edit typo.
 *
 * Anything else (number, string other than the booleans coerced above,
 * array): defaults. The intent here is "make a reasonable PauseConfig
 * from anything", not "validate strictly".
 */
export function normalisePause(raw: unknown): PauseConfig {
  // Legacy boolean shorthand: `paused: true` is master switch on.
  if (raw === true) return { ...defaultPauseConfig(), all: true };
  if (raw === false || raw == null) return defaultPauseConfig();

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultPauseConfig();
  }

  const obj = raw as Record<string, unknown>;
  const bool = (k: string): boolean => obj[k] === true;

  return {
    all: bool('all'),
    polling: bool('polling'),
    download: bool('download'),
    transcribe: bool('transcribe'),
    summarise: bool('summarise'),
  };
}

/**
 * True iff a given step should currently run. The master `all` flag
 * overrides every per-step flag: flipping master on is a single
 * decisive action that doesn't depend on per-step state.
 */
export function shouldRunStep(cfg: PauseConfig, step: PausableStep): boolean {
  if (cfg.all) return false;
  return !cfg[step];
}

/**
 * The list of steps currently effectively paused, in canonical order.
 * When `all` is on, every step is considered paused. Used by the
 * tray status line and submenu to give the right summary.
 */
export function pausedSteps(cfg: PauseConfig): PausableStep[] {
  if (cfg.all) return [...PAUSABLE_STEPS];
  return PAUSABLE_STEPS.filter((s) => cfg[s]);
}

/**
 * Format the pause portion of the tray status line.
 *
 *   - nothing paused: null (caller falls back to "Synced ...").
 *   - master on: "Paused".
 *   - one step: "Paused (downloads)".
 *   - two or more: "Paused (downloads, transcribe)".
 *
 * Step labels here are the user-facing lowercased versions; the
 * canonical type names (`download`, `summarise`) are slightly
 * unfriendly in a status line.
 */
const STATUS_LABEL: Record<PausableStep, string> = {
  polling: 'polling',
  download: 'downloads',
  transcribe: 'transcribe',
  summarise: 'summarise',
};

export function formatPauseStatus(cfg: PauseConfig): string | null {
  if (cfg.all) return 'Paused';
  const steps = pausedSteps(cfg);
  if (steps.length === 0) return null;
  if (steps.length === 1) return `Paused (${STATUS_LABEL[steps[0]!]})`;
  return `Paused (${steps.map((s) => STATUS_LABEL[s]).join(', ')})`;
}
