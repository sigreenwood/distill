import type { InboxItemDTO } from '../shared/api.js';
import type { EssenceActivity } from './tokens.js';

/**
 * Adapted from the Essence asset pack's src/activity.ts starting mapping
 * (see docs/app/HANDOFF.md) to this repository's real pipeline status
 * types instead of a placeholder phase union. 'paused' is part of
 * EssenceActivity for the tray (main/tray.ts has real pause signals) but
 * is never produced here: the inbox window has no pause-state IPC today,
 * so it is deliberately left out of this in-app resolver rather than
 * guessed at.
 */
export interface EssenceSignals {
  /** Any recording currently in status 'error'. */
  needsAttention: boolean;
  /** The active pipeline step of whichever recording is currently running, if any. */
  phase: 'downloading' | 'transcribing' | 'summarising' | 'writing' | null;
  /** Recordings in the untagged inbox, waiting for the user. */
  waitingCount: number;
  /** When a recording most recently finished, for the one-shot completion pulse. */
  completedAt: number | null;
}

/** How long the 'complete' pulse holds before the resolver falls through to waiting/idle. */
export const COMPLETION_TTL_MS = 1800;

export function resolveEssenceActivity(s: EssenceSignals, now = Date.now()): EssenceActivity {
  if (s.needsAttention) return 'error';
  if (s.phase === 'downloading') return 'downloading';
  if (s.phase === 'transcribing') return 'transcribing';
  if (s.phase === 'summarising' || s.phase === 'writing') return 'summarising';
  if (s.completedAt != null && now - s.completedAt >= 0 && now - s.completedAt < COMPLETION_TTL_MS) return 'complete';
  return s.waitingCount > 0 ? 'waiting' : 'idle';
}

/**
 * Derive signals from the inbox window's own already-fetched recordings
 * list — no new IPC channel needed. `completedAt` is threaded through
 * from the caller (see useEssenceActivity.ts), which is the only thing
 * here with the history to know a completion is "recent" rather than a
 * pre-existing complete row from before the window opened.
 */
export function signalsFromInbox(recordings: InboxItemDTO[], completedAt: number | null): EssenceSignals {
  const active = recordings.find(
    (r) =>
      r.status === 'downloading' ||
      r.status === 'transcribing' ||
      r.status === 'summarising' ||
      r.status === 'writing',
  );
  return {
    needsAttention: recordings.some((r) => r.status === 'error'),
    phase: (active?.status as EssenceSignals['phase']) ?? null,
    waitingCount: recordings.filter((r) => r.status === 'inbox').length,
    completedAt,
  };
}
