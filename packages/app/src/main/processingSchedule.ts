/**
 * When the pipeline is allowed to claim new work. Defaults to
 * 'immediate' — the existing "nothing processes until requested, then
 * runs right away" behaviour — so this is entirely opt-in; see
 * ProcessingSchedule.mode in config.ts.
 *
 * This never affects a row already claimed/running: pausing here only
 * stops the *next* claim, exactly like the existing per-step pause
 * (config.ts's PauseConfig). An urgent-flagged row (recordings.urgent)
 * bypasses the gate entirely — see Worker.loop in worker.ts and
 * State.claimNextTagged's urgentOnly parameter.
 */
import type { ProcessingSchedule } from '../shared/processingSchedule.js';
export type { ProcessingSchedule, ProcessingScheduleMode } from '../shared/processingSchedule.js';

export interface ScheduleStatus {
  allowed: boolean;
  /** Why normal claiming is blocked right now; null when allowed. */
  reason: string | null;
}

function parseHm(hm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * True when `now` falls inside the [start, end) window, handling the
 * overnight case where start > end (e.g. 22:00–06:00 crosses midnight).
 * A malformed start/end (fails to parse as HH:MM) is treated as "never
 * in window" rather than throwing — a bad config value should silently
 * hold off processing, not crash the worker loop.
 */
export function isWithinOvernightWindow(now: Date, start: string, end: string): boolean {
  const startMin = parseHm(start);
  const endMin = parseHm(end);
  if (startMin === null || endMin === null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (startMin === endMin) return false;
  if (startMin < endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export function evaluateSchedule(
  schedule: ProcessingSchedule,
  systemIdleSeconds: number,
  now: Date = new Date(),
): ScheduleStatus {
  if (schedule.mode === 'immediate') return { allowed: true, reason: null };
  if (schedule.mode === 'idle') {
    const allowed = systemIdleSeconds >= schedule.idleMinutes * 60;
    return {
      allowed,
      reason: allowed ? null : `Waiting for the Mac to be idle for ${schedule.idleMinutes} minute${schedule.idleMinutes === 1 ? '' : 's'}`,
    };
  }
  const allowed = isWithinOvernightWindow(now, schedule.overnightStart, schedule.overnightEnd);
  return {
    allowed,
    reason: allowed ? null : `Waiting for the overnight window (${schedule.overnightStart}–${schedule.overnightEnd})`,
  };
}
