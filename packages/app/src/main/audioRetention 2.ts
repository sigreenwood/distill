/**
 * Audio retention sweep.
 *
 * The pipeline saves every recording's audio at
 * `~/Library/Application Support/distill/audio/`. Plaud-sourced
 * recordings are kept indefinitely (the user can always re-pull them
 * from the cloud), but locally-imported audio (Teams recordings, voice
 * memos, anything dragged in via the inbox or Dock) is unique on disk
 * and accumulates over time.
 *
 * This module sweeps locally-imported audio whose outputs have been
 * written for at least `audioRetentionDays` days, deleting the file
 * and nulling the row's `audio_path`. The transcript stays in the
 * database so the user can still re-summarise externally with a
 * different prompt or model whenever they want; the audio is just
 * the raw input that produced it, and once transcribed it's spent
 * fuel.
 *
 * The sweep is pure logic for "which rows are eligible" plus a thin
 * filesystem operation. The eligibility logic is fully testable with
 * fake rows and a fake `now` value; the unlink is covered only by
 * manual testing.
 *
 * See BACKLOG.md "Audio retention cleanup" for the original spec, and
 * the in-session decision thread for the `*_written_at`-as-anchor
 * choice.
 */

import { existsSync, unlinkSync } from 'node:fs';
import type { Logger } from 'pino';
import type { State, RecordingRow } from './state.js';

/**
 * Subset of RecordingRow fields needed for the sweep eligibility check.
 * Declared explicitly so the test fixtures don't have to fabricate
 * unrelated fields.
 */
export type SweepCandidateRow = Pick<
  RecordingRow,
  | 'id'
  | 'source'
  | 'status'
  | 'audio_path'
  | 'markdown_written_at'
  | 'html_written_at'
  | 'apple_note_written_at'
>;

export type SweepDecision =
  | { kind: 'delete'; reason: string }
  | { kind: 'keep'; reason: string };

/**
 * Decide whether a single row's audio file should be deleted, given
 * the current retention setting and the current time.
 *
 * Pure function. The reason strings are for logging; callers should
 * include them when a sweep runs so the audit trail is legible.
 */
export function decideForRow(
  row: SweepCandidateRow,
  retentionDays: number | null,
  nowMs: number,
): SweepDecision {
  // Disabled retention: keep everything.
  if (retentionDays === null) {
    return { kind: 'keep', reason: 'retention disabled' };
  }

  // Plaud-sourced audio is always kept (re-fetchable from the cloud,
  // and the user might re-run with updated vocabulary against a
  // higher-quality re-transcription later).
  if (row.source !== 'local') {
    return { kind: 'keep', reason: 'plaud source' };
  }

  // Only sweep terminal-success / explicitly-skipped rows. Error and
  // cancelled rows might be retried, which would need the audio.
  // Inbox / tagged / mid-pipeline rows always need audio.
  if (row.status !== 'complete' && row.status !== 'skipped') {
    return { kind: 'keep', reason: `status=${row.status}` };
  }

  // No audio_path means there's nothing to delete. The row may have
  // had its audio swept on a prior pass, or the file might never have
  // been set (defensive case).
  if (!row.audio_path) {
    return { kind: 'keep', reason: 'no audio_path' };
  }

  // Anchor: most recent successful output write across the three
  // destinations. A row with all three nulls (which shouldn't happen
  // for a 'complete' row but might for a 'skipped' one that was
  // skipped before any write completed) is kept defensively.
  const writes = [
    row.markdown_written_at,
    row.html_written_at,
    row.apple_note_written_at,
  ].filter((t): t is number => typeof t === 'number');

  if (writes.length === 0) {
    return { kind: 'keep', reason: 'no successful writes recorded' };
  }

  const mostRecentWrite = Math.max(...writes);
  const ageMs = nowMs - mostRecentWrite;
  const thresholdMs = retentionDays * 24 * 60 * 60 * 1000;

  if (ageMs < thresholdMs) {
    const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    return {
      kind: 'keep',
      reason: `last write ${ageDays}d ago (threshold ${retentionDays}d)`,
    };
  }

  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  return {
    kind: 'delete',
    reason: `last write ${ageDays}d ago (>= threshold ${retentionDays}d)`,
  };
}

export interface SweepResult {
  /** Rows whose audio file was deleted in this pass. */
  deleted: Array<{ id: string; path: string }>;
  /** Rows where audio_path was set but the file was already gone. */
  alreadyMissing: Array<{ id: string; path: string }>;
  /** Rows where the unlink itself threw (permissions, etc.). */
  failed: Array<{ id: string; path: string; error: string }>;
  /** Number of candidates considered (post-`source: 'local'` filter). */
  considered: number;
}

/**
 * Run the sweep. Walks every locally-imported recording, applies
 * `decideForRow`, deletes audio files for rows the function approves,
 * and nulls out `audio_path` on the row so the inbox doesn't show a
 * broken Reveal-in-Finder.
 *
 * Returns a summary. Callers should log the summary at info level on
 * a non-empty pass, debug otherwise.
 *
 * The state argument is the live State; the function mutates rows
 * via `state.updateRecording`. The fs argument is injectable for
 * testing — production callers pass `nodeFs`.
 */
export interface SweepFs {
  existsSync: (path: string) => boolean;
  unlinkSync: (path: string) => void;
}

export const nodeFs: SweepFs = {
  existsSync,
  unlinkSync,
};

/**
 * State surface the sweep needs. Declared narrowly so tests can
 * provide a fake without implementing the full State class.
 */
export interface SweepState {
  listLocalCandidates(): SweepCandidateRow[];
  updateRecording(id: string, patch: { audio_path: null }): void;
}

/**
 * Concrete adapter that exposes the slice of `State` that the sweep
 * needs. Kept here rather than as a method on `State` itself because
 * the query is sweep-specific and adding it to the main store muddles
 * the API surface.
 */
export function sweepStateFor(state: State): SweepState {
  return {
    listLocalCandidates() {
      // Read every locally-imported row regardless of status; the
      // eligibility check filters further. Cheap query — local rows
      // are typically tens, not thousands.
      return (state as unknown as {
        db: import('better-sqlite3').Database;
      }).db
        .prepare<[], SweepCandidateRow>(
          `SELECT id, source, status, audio_path,
                  markdown_written_at, html_written_at, apple_note_written_at
           FROM recordings
           WHERE source = 'local'`,
        )
        .all();
    },
    updateRecording(id, patch) {
      state.updateRecording(id, patch);
    },
  };
}

export function runSweep(
  state: SweepState,
  retentionDays: number | null,
  fs: SweepFs,
  logger: Logger,
  nowMs: number = Date.now(),
): SweepResult {
  const result: SweepResult = {
    deleted: [],
    alreadyMissing: [],
    failed: [],
    considered: 0,
  };

  // Short-circuit: retention disabled means we don't even read the DB.
  if (retentionDays === null) {
    logger.debug('audio retention disabled (audioRetentionDays=null)');
    return result;
  }

  const candidates = state.listLocalCandidates();
  result.considered = candidates.length;

  for (const row of candidates) {
    const decision = decideForRow(row, retentionDays, nowMs);
    if (decision.kind === 'keep') {
      logger.debug(
        { recordingId: row.id, reason: decision.reason },
        'audio retention: keep',
      );
      continue;
    }

    // Eligible for deletion. row.audio_path is non-null per the
    // decideForRow contract — narrow the type.
    const path = row.audio_path!;

    if (!fs.existsSync(path)) {
      // File already gone (user manually deleted, audio dir moved,
      // disk wiped, etc.). Null the audio_path so the row stops
      // claiming a file that isn't there.
      state.updateRecording(row.id, { audio_path: null });
      result.alreadyMissing.push({ id: row.id, path });
      logger.debug(
        { recordingId: row.id, path },
        'audio retention: file already missing, cleared audio_path',
      );
      continue;
    }

    try {
      fs.unlinkSync(path);
      state.updateRecording(row.id, { audio_path: null });
      result.deleted.push({ id: row.id, path });
      logger.info(
        { recordingId: row.id, path, reason: decision.reason },
        'audio retention: deleted',
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      result.failed.push({ id: row.id, path, error: err });
      logger.warn(
        { recordingId: row.id, path, error: err },
        'audio retention: unlink failed',
      );
    }
  }

  return result;
}

/**
 * Schedule periodic sweeps. The first sweep happens immediately
 * (caller typically invokes after app init); subsequent sweeps run
 * every 24 hours via `setInterval`.
 *
 * Returns a stop function that clears the interval — useful for
 * tests and for clean shutdown in `before-quit`.
 */
export function startSweepSchedule(opts: {
  state: SweepState;
  getRetentionDays: () => number | null;
  fs: SweepFs;
  logger: Logger;
  /** Override for testing; production uses 24 hours. */
  intervalMs?: number;
}): () => void {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;

  // Run once at startup. Wrapped in try so a sweep error never crashes
  // the main process - retention is best-effort cleanup, not critical.
  const safeRun = (): void => {
    try {
      runSweep(opts.state, opts.getRetentionDays(), opts.fs, opts.logger);
    } catch (e) {
      opts.logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        'audio retention sweep threw unexpectedly',
      );
    }
  };

  safeRun();
  const handle = setInterval(safeRun, intervalMs);
  return () => clearInterval(handle);
}
