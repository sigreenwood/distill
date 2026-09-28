import { describe, it, expect, beforeEach } from 'vitest';
import {
  TIP_JAR_THRESHOLD,
  TIP_JAR_URL,
  dismissBanner,
  readTipJarStatus,
  recordCompletion,
  type TipJarStateLike,
} from '../src/main/tipJar.js';

/**
 * Tests for the tip-jar bookkeeping helpers. These cover the
 * counter increment, the once-only threshold notification, the
 * banner dismiss, and corruption-tolerant reads.
 *
 * Why a fake instead of an in-memory better-sqlite3 DB? The native
 * module is compiled against Electron's Node ABI and vitest runs
 * against the system Node ABI; the two don't always agree (see the
 * comment at the top of test/poller.test.ts). The tip-jar helpers
 * only ever touch two app_state methods, so typing them on
 * TipJarStateLike lets a Map-backed fake stand in cleanly.
 */

function makeFakeState(): TipJarStateLike {
  // Map keeps key/value pairs in insertion order; we only need
  // get/set semantics. Returning the literal so each test gets a
  // fresh Map.
  const store = new Map<string, string>();
  return {
    getAppState: (key) => store.get(key),
    setAppState: (key, value) => {
      store.set(key, value);
    },
  };
}

describe('readTipJarStatus', () => {
  let state: TipJarStateLike;
  beforeEach(() => {
    state = makeFakeState();
  });

  it('returns zero / false defaults on a fresh install', () => {
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(0);
    expect(status.bannerDismissed).toBe(false);
    expect(status.thresholdNotified).toBe(false);
    expect(status.shouldShowBanner).toBe(false);
  });

  it('exposes the URL and threshold for renderer wording', () => {
    const status = readTipJarStatus(state);
    expect(status.url).toBe(TIP_JAR_URL);
    expect(status.threshold).toBe(TIP_JAR_THRESHOLD);
  });

  it('shouldShowBanner is true once count >= threshold and not dismissed', () => {
    // Drive the counter up to threshold via repeated recordCompletion
    // calls. Faster than poking app_state directly and exercises the
    // increment path.
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) recordCompletion(state);
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(TIP_JAR_THRESHOLD);
    expect(status.shouldShowBanner).toBe(true);
  });

  it('shouldShowBanner is false once dismissed, even past threshold', () => {
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) recordCompletion(state);
    dismissBanner(state);
    const status = readTipJarStatus(state);
    expect(status.bannerDismissed).toBe(true);
    expect(status.shouldShowBanner).toBe(false);
  });

  it('treats a corrupt count value as zero rather than throwing', () => {
    // Hand-edited or migrated state.db with a non-numeric value
    // should not crash the renderer when it asks for status. The
    // counter resumes from 0; the banner is hidden until the user
    // does another THRESHOLD completions. Trade-off documented in
    // tipJar.ts.
    state.setAppState('tip_jar_completion_count', 'oops');
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(0);
    expect(status.shouldShowBanner).toBe(false);
  });

  it('treats a negative count value as zero', () => {
    state.setAppState('tip_jar_completion_count', '-5');
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(0);
  });

  it('treats a non-integer count value as zero', () => {
    state.setAppState('tip_jar_completion_count', '1.5');
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(0);
  });
});

describe('recordCompletion', () => {
  let state: TipJarStateLike;
  beforeEach(() => {
    state = makeFakeState();
  });

  it('increments the counter on each call', () => {
    expect(recordCompletion(state).count).toBe(1);
    expect(recordCompletion(state).count).toBe(2);
    expect(recordCompletion(state).count).toBe(3);
  });

  it('returns kind="incremented" before the threshold', () => {
    const outcome = recordCompletion(state);
    expect(outcome.kind).toBe('incremented');
  });

  it('returns kind="threshold-just-hit" exactly once on crossing the threshold', () => {
    let firstCrossing: ReturnType<typeof recordCompletion> | null = null;
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) {
      const outcome = recordCompletion(state);
      if (outcome.kind === 'threshold-just-hit') firstCrossing = outcome;
    }
    expect(firstCrossing).not.toBeNull();
    expect(firstCrossing!.count).toBe(TIP_JAR_THRESHOLD);

    // Subsequent completions must NOT report threshold-just-hit
    // again (the flag is sticky). They should fall into the
    // already-past-threshold branch instead.
    const next = recordCompletion(state);
    expect(next.kind).toBe('already-past-threshold');
    expect(next.count).toBe(TIP_JAR_THRESHOLD + 1);
  });

  it('sets the sticky thresholdNotified flag on first crossing', () => {
    expect(readTipJarStatus(state).thresholdNotified).toBe(false);
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) recordCompletion(state);
    expect(readTipJarStatus(state).thresholdNotified).toBe(true);
  });

  it('does not re-fire threshold-just-hit even if the user manually resets the count', () => {
    // First crossing: fires.
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) recordCompletion(state);
    expect(readTipJarStatus(state).thresholdNotified).toBe(true);

    // Manual reset (simulating a user editing state.db). The flag
    // is sticky on purpose — the threshold notification is a
    // once-per-install greeting, not a recurring prompt.
    state.setAppState('tip_jar_completion_count', '0');

    // Cross the threshold again. The outcome must NOT report
    // threshold-just-hit because the flag is still set.
    let saw = false;
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) {
      const outcome = recordCompletion(state);
      if (outcome.kind === 'threshold-just-hit') saw = true;
    }
    expect(saw).toBe(false);
  });

  it('writes the count back to app_state on every increment', () => {
    // Direct read against the underlying store to confirm we're
    // actually persisting. (Fakes can have bugs too; verifying the
    // round-trip protects against silent regressions if someone
    // refactors the helper.)
    recordCompletion(state);
    expect(state.getAppState('tip_jar_completion_count')).toBe('1');
    recordCompletion(state);
    expect(state.getAppState('tip_jar_completion_count')).toBe('2');
  });
});

describe('dismissBanner', () => {
  let state: TipJarStateLike;
  beforeEach(() => {
    state = makeFakeState();
  });

  it('sets the sticky bannerDismissed flag', () => {
    expect(readTipJarStatus(state).bannerDismissed).toBe(false);
    dismissBanner(state);
    expect(readTipJarStatus(state).bannerDismissed).toBe(true);
  });

  it('is idempotent — calling twice keeps the flag set', () => {
    dismissBanner(state);
    dismissBanner(state);
    expect(readTipJarStatus(state).bannerDismissed).toBe(true);
  });

  it('does not affect the counter or thresholdNotified flag', () => {
    for (let i = 0; i < TIP_JAR_THRESHOLD; i++) recordCompletion(state);
    dismissBanner(state);
    const status = readTipJarStatus(state);
    expect(status.completionCount).toBe(TIP_JAR_THRESHOLD);
    expect(status.thresholdNotified).toBe(true);
  });

  it('writes "1" to app_state for the dismissed key', () => {
    dismissBanner(state);
    expect(state.getAppState('tip_jar_banner_dismissed')).toBe('1');
  });
});
