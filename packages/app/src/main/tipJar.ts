import type { State } from './state.js';

const TIP_JAR_URL = 'https://buymeacoffee.com/distill';
const TIP_JAR_THRESHOLD = 50;
const KEY_COUNT = 'tip_jar_completion_count';
const KEY_BANNER_DISMISSED = 'tip_jar_banner_dismissed';
const KEY_THRESHOLD_NOTIFIED = 'tip_jar_threshold_notified';

export interface TipJarStatus {
  completionCount: number;
  bannerDismissed: boolean;
  thresholdNotified: boolean;
  shouldShowBanner: boolean;
  url: string;
  threshold: number;
}

export type RecordCompletionResult =
  | { kind: 'threshold-just-hit'; count: number }
  | { kind: 'already-past-threshold'; count: number }
  | { kind: 'incremented'; count: number };

export function readTipJarStatus(state: State): TipJarStatus {
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

export function recordCompletion(state: State): RecordCompletionResult {
  const previousCount = readInt(state, KEY_COUNT, 0);
  const newCount = previousCount + 1;
  state.setAppState(KEY_COUNT, String(newCount));
  if (newCount >= TIP_JAR_THRESHOLD && !readBool(state, KEY_THRESHOLD_NOTIFIED)) {
    state.setAppState(KEY_THRESHOLD_NOTIFIED, '1');
    return { kind: 'threshold-just-hit', count: newCount };
  }
  if (newCount >= TIP_JAR_THRESHOLD) {
    return { kind: 'already-past-threshold', count: newCount };
  }
  return { kind: 'incremented', count: newCount };
}

export function dismissBanner(state: State): void {
  state.setAppState(KEY_BANNER_DISMISSED, '1');
}

function readInt(state: State, key: string, fallback: number): number {
  const raw = state.getAppState(key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function readBool(state: State, key: string): boolean {
  return state.getAppState(key) === '1';
}
