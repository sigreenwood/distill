/**
 * Tip-jar helpers.
 *
 * distill is free, local-first, and ad-free. The tip jar is an
 * unobtrusive way for happy users to chip in toward continued
 * development. Three surfaces:
 *
 *   - **Tray menu**: a "Buy me a coffee…" item, always visible, opens
 *     the URL in the user's default browser.
 *   - **Settings → About**: a small "Support development" link in the
 *     About pane footer.
 *   - **Inbox banner**: shown once after the user has completed
 *     `THRESHOLD` summaries, dismissable, never shown again. The
 *     wording leans on the user's own evidence — they've already used
 *     the app fifty times — rather than a vague pitch.
 *
 * State lives in `app_state`, three string keys:
 *   - `tip_jar_completion_count`     integer, increments on every
 *                                    pipeline complete
 *   - `tip_jar_banner_dismissed`     '1' once the user dismisses the
 *                                    banner; never written back to '0'
 *   - `tip_jar_threshold_notified`   '1' after the threshold tray
 *                                    notification fires once; never
 *                                    written back to '0'
 *
 * Three-flag design rather than a single counter is deliberate: each
 * surface needs to know its OWN whether-already-shown without leaking
 * state into the others. Dismissing the banner doesn't suppress the
 * tray notification (different surface, different consent), and a
 * second "you've crossed 50 again" tray ping if the user resets
 * counts manually would be wrong — the threshold-notified flag is
 * sticky.
 *
 * No new SQLite migration needed: app_state is a generic key/value
 * store and these keys are typed as strings (parsed to int on read).
 */

/**
 * Narrow interface over `State` used by the tip-jar helpers. We only
 * need the two app_state accessors, so typing on the narrowed shape
 * lets tests substitute a tiny in-memory fake without dragging
 * better-sqlite3 into the test runtime. (The native module is
 * compiled against Electron's Node ABI; vitest runs against the
 * system's Node ABI, and the two don't always agree — see the
 * comment at the top of test/poller.test.ts.)
 */
export interface TipJarStateLike {
  getAppState(key: string): string | undefined;
  setAppState(key: string, value: string): void;
}

/**
 * Where the tip jar lives. Defined here as a single constant so a
 * future swap to a different platform (Stripe link, GitHub Sponsors,
 * etc.) is one edit. The URL is opened via shell.openExternal at
 * three call sites: tray menu, banner button, About link.
 */
export const TIP_JAR_URL = 'https://buymeacoffee.com/distill';

/**
 * How many completed summaries trigger the threshold surface (banner
 * + one-shot tray notification). Picked to be high enough that the
 * user has clearly found the app useful, low enough that any active
 * user reaches it within a month or two of normal use.
 */
export const TIP_JAR_THRESHOLD = 50;

const KEY_COUNT = 'tip_jar_completion_count';
const KEY_BANNER_DISMISSED = 'tip_jar_banner_dismissed';
const KEY_THRESHOLD_NOTIFIED = 'tip_jar_threshold_notified';

/**
 * Snapshot of tip-jar state used by the renderer (banner) and the
 * Settings About pane. The renderer needs all three flags so it can
 * decide whether to show the banner without doing arithmetic itself.
 */
export interface TipJarStatus {
  /** Number of completed summaries since this install was created. */
  completionCount: number;
  /** True once the user has dismissed the banner. */
  bannerDismissed: boolean;
  /** True once the threshold tray notification has fired. */
  thresholdNotified: boolean;
  /**
   * True iff the inbox should display the threshold banner right now
   * (count >= threshold AND not dismissed). Derived for renderer
   * convenience so the UI doesn't need to know the threshold value.
   */
  shouldShowBanner: boolean;
  /** The URL the surfaces link to. Repeated here so the renderer doesn't import main code. */
  url: string;
  /** The threshold value, also surfaced to the renderer for wording. */
  threshold: number;
}

/**
 * Read the current tip-jar status. Cheap — three indexed point
 * lookups against app_state. Safe to call on every inbox render.
 */
export function readTipJarStatus(state: TipJarStateLike): TipJarStatus {
  const completionCount = readInt(state, KEY_COUNT, 0);
  const bannerDismissed = readBool(state, KEY_BANNER_DISMISSED);
  const thresholdNotified = readBool(state, KEY_THRESHOLD_NOTIFIED);
  return {
    completionCount,
    bannerDismissed,
    thresholdNotified,
    shouldShowBanner: completionCount >= TIP_JAR_THRESHOLD && !bannerDismissed,
    url: TIP_JAR_URL,
    threshold: TIP_JAR_THRESHOLD,
  };
}

/**
 * Outcome of recording a completion. Three possible states:
 *
 *   - `'incremented'`: count went up; nothing else to do.
 *   - `'threshold-just-hit'`: count crossed THRESHOLD on this call AND
 *     the threshold notification hasn't fired yet. Caller should fire
 *     the tray notification. The threshold-notified flag is set to '1'
 *     atomically here so a rapid second completion can't double-fire.
 *   - `'already-past-threshold'`: count is past THRESHOLD but the
 *     notification already fired earlier. Just incremented the count.
 *
 * The `count` field carries the post-increment value for logging.
 */
export interface RecordCompletionOutcome {
  kind: 'incremented' | 'threshold-just-hit' | 'already-past-threshold';
  count: number;
}

/**
 * Increment the completion counter and decide whether the threshold
 * notification should fire. Single transactional unit: read
 * count + flag, write incremented count, possibly set flag, return
 * outcome.
 *
 * Called from `index.ts::onComplete`. Idempotent if the same
 * completion is somehow recorded twice in a row — the second call
 * just increments to N+2; threshold-notified flag stays sticky.
 *
 * Parameter `now` is unused but kept off the signature so the
 * function stays a pure function of `state` for testability. (If
 * later we want to add a "first completion at" timestamp this is
 * where it would land.)
 */
export function recordCompletion(state: TipJarStateLike): RecordCompletionOutcome {
  const previousCount = readInt(state, KEY_COUNT, 0);
  const newCount = previousCount + 1;
  state.setAppState(KEY_COUNT, String(newCount));

  // Cross-the-line check. The flag is sticky so a user who manually
  // resets the count (e.g. by editing state.db) won't get the
  // notification again — that's the correct behaviour: notification
  // is a once-per-install greeting, not a recurring prompt.
  if (
    newCount >= TIP_JAR_THRESHOLD &&
    !readBool(state, KEY_THRESHOLD_NOTIFIED)
  ) {
    state.setAppState(KEY_THRESHOLD_NOTIFIED, '1');
    return { kind: 'threshold-just-hit', count: newCount };
  }

  if (newCount >= TIP_JAR_THRESHOLD) {
    return { kind: 'already-past-threshold', count: newCount };
  }
  return { kind: 'incremented', count: newCount };
}

/**
 * Mark the banner as dismissed. Sticky — never written back to '0'
 * via this helper. A user who really wants the banner back can
 * delete the key from state.db manually; that's a deliberate
 * footgun (we don't want a hidden "undismiss" button cluttering the
 * Settings UI for what is meant to be a one-time interaction).
 */
export function dismissBanner(state: TipJarStateLike): void {
  state.setAppState(KEY_BANNER_DISMISSED, '1');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readInt(state: TipJarStateLike, key: string, fallback: number): number {
  const raw = state.getAppState(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    // Defensive: treat a corrupt value as 0 rather than throwing. The
    // counter will resume incrementing from 0 next completion, which
    // means the banner won't fire until the user does another
    // THRESHOLD completions — acceptable trade-off vs. crashing on a
    // hand-edited state.db.
    return fallback;
  }
  return parsed;
}

function readBool(state: TipJarStateLike, key: string): boolean {
  // We write '1' for true and never write false (sticky semantics),
  // so a present-and-equals-'1' value is the only way the bit is set.
  return state.getAppState(key) === '1';
}
