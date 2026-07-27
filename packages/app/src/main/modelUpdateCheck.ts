import { checkForNewerGeneration, type ModelSuggestion } from './modelAdvisor.js';
import type { Logger } from './logger.js';
import type { State } from './state.js';

const KEY_LAST_RUN = 'model_check_last_run';
const KEY_SUGGESTION = 'model_check_suggestion';
const KEY_DISMISSED_FAMILY = 'model_check_dismissed_family';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const TICK_MS = 24 * 60 * 60 * 1000;

export interface ModelUpdateCheckOptions {
  state: State;
  logger: Logger;
  getCurrentModel: () => string;
  /** Fired when a NEW (not-dismissed, not-previously-seen) suggestion lands. */
  onSuggestion: (s: ModelSuggestion) => void;
}

/** Read the stored suggestion, unless the user dismissed that family. */
export function readModelSuggestion(state: State): ModelSuggestion | null {
  const raw = state.getAppState(KEY_SUGGESTION);
  if (!raw) return null;
  let parsed: ModelSuggestion;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (state.getAppState(KEY_DISMISSED_FAMILY) === parsed.newFamily) return null;
  return parsed;
}

/**
 * Dismiss the current suggestion's family. A later, newer family (e.g.
 * dismissing qwen3.7 then qwen3.8 ships) will still surface, because the
 * dismissal is keyed to the exact family name.
 */
export function dismissModelSuggestion(state: State): void {
  const raw = state.getAppState(KEY_SUGGESTION);
  if (!raw) return;
  try {
    const parsed: ModelSuggestion = JSON.parse(raw);
    state.setAppState(KEY_DISMISSED_FAMILY, parsed.newFamily);
  } catch {
    // nothing sensible to dismiss
  }
}

/**
 * Weekly newer-generation check, evaluated on a daily tick (plus one run
 * shortly after startup) so a Mac that sleeps through the scheduled moment
 * still catches up. Suggestion-only by design — the check never pulls a
 * model itself.
 *
 * Returns a stop function.
 */
export function startModelUpdateCheck(opts: ModelUpdateCheckOptions): () => void {
  const probe = async (url: string) => {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return { status: res.status, ok: res.ok };
  };

  const runIfDue = async () => {
    const lastRun = Number(opts.state.getAppState(KEY_LAST_RUN) ?? 0);
    if (Date.now() - lastRun < WEEK_MS) return;
    opts.state.setAppState(KEY_LAST_RUN, String(Date.now()));
    const currentModel = opts.getCurrentModel();
    try {
      const suggestion = await checkForNewerGeneration(currentModel, probe);
      if (!suggestion) {
        opts.logger.info({ currentModel }, 'model update check: no newer generation found');
        return;
      }
      const previous = opts.state.getAppState(KEY_SUGGESTION);
      const previousFamily = previous ? (JSON.parse(previous) as ModelSuggestion).newFamily : null;
      opts.state.setAppState(KEY_SUGGESTION, JSON.stringify(suggestion));
      const dismissed = opts.state.getAppState(KEY_DISMISSED_FAMILY) === suggestion.newFamily;
      opts.logger.info(
        { currentModel, newFamily: suggestion.newFamily, dismissed },
        'model update check: newer generation available',
      );
      // Notify only on first sighting of this family, and never for a
      // family the user already waved away.
      if (!dismissed && previousFamily !== suggestion.newFamily) {
        opts.onSuggestion(suggestion);
      }
    } catch (e) {
      opts.logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        'model update check failed (non-fatal)',
      );
    }
  };

  // First run shortly after startup so it doesn't compete with launch work.
  const startupTimer = setTimeout(() => void runIfDue(), 60_000);
  const interval = setInterval(() => void runIfDue(), TICK_MS);
  return () => {
    clearTimeout(startupTimer);
    clearInterval(interval);
  };
}
