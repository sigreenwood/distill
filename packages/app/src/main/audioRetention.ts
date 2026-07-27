import fs from 'node:fs';
import type { Logger } from './logger.js';
import type { RecordingRow, State } from './state.js';

/**
 * Audio retention only applies to locally-imported recordings — Plaud
 * recordings keep their cloud copy, so the local cache is the only copy
 * for 'local' rows and we delete it only after outputs have landed and
 * the retention window has passed.
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

export type SweepDecision = { kind: 'keep'; reason: string } | { kind: 'delete'; reason: string };

export function decideForRow(
  row: SweepCandidateRow,
  retentionDays: number | null,
  nowMs: number,
): SweepDecision {
  if (retentionDays === null) {
    return { kind: 'keep', reason: 'retention disabled' };
  }
  if (row.source !== 'local') {
    return { kind: 'keep', reason: 'plaud source' };
  }
  if (row.status !== 'complete' && row.status !== 'skipped') {
    return { kind: 'keep', reason: `status=${row.status}` };
  }
  if (!row.audio_path) {
    return { kind: 'keep', reason: 'no audio_path' };
  }
  const writes = [row.markdown_written_at, row.html_written_at, row.apple_note_written_at].filter(
    (t): t is number => typeof t === 'number',
  );
  if (writes.length === 0) {
    return { kind: 'keep', reason: 'no successful writes recorded' };
  }
  const mostRecentWrite = Math.max(...writes);
  const ageMs = nowMs - mostRecentWrite;
  const thresholdMs = retentionDays * 24 * 60 * 60 * 1000;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageMs < thresholdMs) {
    return { kind: 'keep', reason: `last write ${ageDays}d ago (threshold ${retentionDays}d)` };
  }
  return { kind: 'delete', reason: `last write ${ageDays}d ago (>= threshold ${retentionDays}d)` };
}

export interface SweepFs {
  existsSync: (p: string) => boolean;
  unlinkSync: (p: string) => void;
}

export const nodeFs: SweepFs = {
  existsSync: fs.existsSync,
  unlinkSync: fs.unlinkSync,
};

export interface SweepState {
  listLocalCandidates(): SweepCandidateRow[];
  updateRecording(id: string, patch: Partial<RecordingRow>): void;
}

export function sweepStateFor(state: State): SweepState {
  return {
    listLocalCandidates(): SweepCandidateRow[] {
      return state.db
        .prepare(
          `SELECT id, source, status, audio_path,
                  markdown_written_at, html_written_at, apple_note_written_at
           FROM recordings
           WHERE source = 'local'`,
        )
        .all() as SweepCandidateRow[];
    },
    updateRecording(id: string, patch: Partial<RecordingRow>): void {
      state.updateRecording(id, patch);
    },
  };
}

export interface SweepResult {
  deleted: { id: string; path: string }[];
  alreadyMissing: { id: string; path: string }[];
  failed: { id: string; path: string; error: string }[];
  considered: number;
}

export function runSweep(
  state: SweepState,
  retentionDays: number | null,
  fsImpl: SweepFs,
  logger: Logger,
  nowMs: number = Date.now(),
): SweepResult {
  const result: SweepResult = {
    deleted: [],
    alreadyMissing: [],
    failed: [],
    considered: 0,
  };
  if (retentionDays === null) {
    logger.debug('audio retention disabled (audioRetentionDays=null)');
    return result;
  }
  const candidates = state.listLocalCandidates();
  result.considered = candidates.length;
  for (const row of candidates) {
    const decision = decideForRow(row, retentionDays, nowMs);
    if (decision.kind === 'keep') {
      logger.debug({ recordingId: row.id, reason: decision.reason }, 'audio retention: keep');
      continue;
    }
    const p = row.audio_path!;
    if (!fsImpl.existsSync(p)) {
      state.updateRecording(row.id, { audio_path: null });
      result.alreadyMissing.push({ id: row.id, path: p });
      logger.debug(
        { recordingId: row.id, path: p },
        'audio retention: file already missing, cleared audio_path',
      );
      continue;
    }
    try {
      fsImpl.unlinkSync(p);
      state.updateRecording(row.id, { audio_path: null });
      result.deleted.push({ id: row.id, path: p });
      logger.info({ recordingId: row.id, path: p, reason: decision.reason }, 'audio retention: deleted');
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      result.failed.push({ id: row.id, path: p, error: err });
      logger.warn({ recordingId: row.id, path: p, error: err }, 'audio retention: unlink failed');
    }
  }
  return result;
}

export interface SweepScheduleOptions {
  state: SweepState;
  getRetentionDays: () => number | null;
  fs: SweepFs;
  logger: Logger;
  intervalMs?: number;
}

/** Run one sweep immediately, then daily. Returns a stop function. */
export function startSweepSchedule(opts: SweepScheduleOptions): () => void {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1000;
  const safeRun = () => {
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
