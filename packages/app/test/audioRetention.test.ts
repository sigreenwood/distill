/**
 * Tests for the audio retention sweep.
 *
 * The eligibility logic (`decideForRow`) is pure and gets the bulk of
 * the coverage. The orchestration (`runSweep`) is exercised with a
 * fake state and fake filesystem so we can assert the right rows were
 * deleted, audio_path was nulled out, and counters in the SweepResult
 * are correct.
 */

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  decideForRow,
  runSweep,
  type SweepCandidateRow,
  type SweepFs,
  type SweepState,
} from '../src/main/audioRetention.js';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000; // arbitrary fixed epoch ms

function row(overrides: Partial<SweepCandidateRow> = {}): SweepCandidateRow {
  return {
    id: 'rec-1',
    source: 'local',
    status: 'complete',
    audio_path: '/tmp/audio/rec-1.mp3',
    markdown_written_at: NOW - 30 * ONE_DAY_MS, // 30 days old
    html_written_at: null,
    apple_note_written_at: null,
    ...overrides,
  };
}

describe('decideForRow', () => {
  it('keeps everything when retentionDays is null', () => {
    expect(decideForRow(row(), null, NOW)).toEqual({
      kind: 'keep',
      reason: 'retention disabled',
    });
  });

  it('keeps Plaud-sourced rows regardless of age', () => {
    const r = row({ source: 'plaud' });
    expect(decideForRow(r, 14, NOW).kind).toBe('keep');
  });

  it('keeps rows that are not complete or skipped', () => {
    // Inbox / tagged / mid-pipeline / error / cancelled rows always need
    // their audio. Only complete and skipped are sweepable.
    for (const status of ['inbox', 'tagged', 'downloading', 'transcribing',
                          'summarising', 'writing', 'error', 'cancelled'] as const) {
      const r = row({ status });
      const decision = decideForRow(r, 0, NOW);
      expect(decision.kind).toBe('keep');
      expect(decision.reason).toContain(status);
    }
  });

  it('sweeps complete rows', () => {
    expect(decideForRow(row({ status: 'complete' }), 14, NOW).kind).toBe('delete');
  });

  it('sweeps skipped rows', () => {
    expect(decideForRow(row({ status: 'skipped' }), 14, NOW).kind).toBe('delete');
  });

  it('keeps rows with no audio_path', () => {
    const r = row({ audio_path: null });
    expect(decideForRow(r, 14, NOW)).toMatchObject({
      kind: 'keep',
      reason: 'no audio_path',
    });
  });

  it('keeps complete rows with no successful writes recorded', () => {
    // Defensive: a complete row should always have at least one write
    // timestamp, but the data could be weird (e.g. a hand-edited row,
    // or a status set to complete by something other than the pipeline).
    // Better to keep audio than delete it on shaky grounds.
    const r = row({
      markdown_written_at: null,
      html_written_at: null,
      apple_note_written_at: null,
    });
    expect(decideForRow(r, 0, NOW)).toMatchObject({
      kind: 'keep',
      reason: 'no successful writes recorded',
    });
  });

  it('keeps rows whose latest write is younger than the threshold', () => {
    // 7 days old, 14-day retention: keep.
    const r = row({ markdown_written_at: NOW - 7 * ONE_DAY_MS });
    const decision = decideForRow(r, 14, NOW);
    expect(decision.kind).toBe('keep');
    expect(decision.reason).toContain('7d ago');
  });

  it('deletes rows whose latest write is at or past the threshold', () => {
    // Exactly 14 days old, 14-day retention: delete (>=).
    const r = row({ markdown_written_at: NOW - 14 * ONE_DAY_MS });
    expect(decideForRow(r, 14, NOW).kind).toBe('delete');

    // 30 days old, 14-day retention: delete.
    const r2 = row({ markdown_written_at: NOW - 30 * ONE_DAY_MS });
    expect(decideForRow(r2, 14, NOW).kind).toBe('delete');
  });

  it('uses the most recent write timestamp across the three destinations', () => {
    // Markdown wrote 30 days ago; HTML re-wrote yesterday. Yesterday wins,
    // so with a 14-day retention this row is kept.
    const r = row({
      markdown_written_at: NOW - 30 * ONE_DAY_MS,
      html_written_at: NOW - 1 * ONE_DAY_MS,
      apple_note_written_at: null,
    });
    const decision = decideForRow(r, 14, NOW);
    expect(decision.kind).toBe('keep');
    expect(decision.reason).toContain('1d ago');
  });

  it('treats retentionDays=0 as immediate (any age past the write)', () => {
    // 1ms past write: deletes.
    const r = row({ markdown_written_at: NOW - 1 });
    expect(decideForRow(r, 0, NOW).kind).toBe('delete');
  });

  it('with retentionDays=0, still keeps rows where ageMs is exactly 0', () => {
    // Edge case: the write happened this exact ms. 0ms is not >= 0ms-threshold
    // mathematically (it IS >= 0, so it deletes). This is consistent with
    // "0 = immediate" semantics. Pinning the behaviour:
    const r = row({ markdown_written_at: NOW });
    expect(decideForRow(r, 0, NOW).kind).toBe('delete');
  });
});

// ---------------------------------------------------------------------------
// runSweep — orchestration
// ---------------------------------------------------------------------------

function fakeFs(opts?: {
  exists?: (p: string) => boolean;
  unlink?: (p: string) => void;
}): SweepFs {
  return {
    existsSync: opts?.exists ?? (() => true),
    unlinkSync: opts?.unlink ?? (() => {}),
  };
}

function fakeState(rows: SweepCandidateRow[]): SweepState & {
  updates: Array<{ id: string; patch: { audio_path: null } }>;
} {
  const updates: Array<{ id: string; patch: { audio_path: null } }> = [];
  return {
    listLocalCandidates: () => rows,
    updateRecording: (id, patch) => {
      updates.push({ id, patch });
    },
    updates,
  };
}

const silentLogger = pino({ level: 'silent' });

describe('runSweep', () => {
  it('does nothing when retention is disabled', () => {
    const state = fakeState([row()]);
    const fs = fakeFs();
    const result = runSweep(state, null, fs, silentLogger, NOW);
    expect(result.deleted).toEqual([]);
    expect(result.considered).toBe(0);
    expect(state.updates).toEqual([]);
  });

  it('deletes eligible rows and nulls audio_path', () => {
    const r = row({ id: 'rec-1', markdown_written_at: NOW - 30 * ONE_DAY_MS });
    const state = fakeState([r]);
    const unlinked: string[] = [];
    const fs = fakeFs({ unlink: (p) => unlinked.push(p) });

    const result = runSweep(state, 14, fs, silentLogger, NOW);

    expect(unlinked).toEqual([r.audio_path]);
    expect(result.deleted).toEqual([{ id: 'rec-1', path: r.audio_path }]);
    expect(state.updates).toEqual([{ id: 'rec-1', patch: { audio_path: null } }]);
  });

  it('skips files that are already missing but still nulls audio_path', () => {
    const r = row({ id: 'rec-1', markdown_written_at: NOW - 30 * ONE_DAY_MS });
    const state = fakeState([r]);
    const fs = fakeFs({ exists: () => false });

    const result = runSweep(state, 14, fs, silentLogger, NOW);

    expect(result.deleted).toEqual([]);
    expect(result.alreadyMissing).toEqual([{ id: 'rec-1', path: r.audio_path }]);
    // Still nulls audio_path so the row stops claiming a missing file.
    expect(state.updates).toEqual([{ id: 'rec-1', patch: { audio_path: null } }]);
  });

  it('records unlink failures without nulling audio_path', () => {
    const r = row({ id: 'rec-1', markdown_written_at: NOW - 30 * ONE_DAY_MS });
    const state = fakeState([r]);
    const fs = fakeFs({
      unlink: () => {
        throw new Error('permission denied');
      },
    });

    const result = runSweep(state, 14, fs, silentLogger, NOW);

    expect(result.deleted).toEqual([]);
    expect(result.failed).toEqual([
      { id: 'rec-1', path: r.audio_path, error: 'permission denied' },
    ]);
    // Did NOT null audio_path - the file is still on disk, claiming it
    // would be a lie.
    expect(state.updates).toEqual([]);
  });

  it('considers all candidates, deletes only the eligible ones', () => {
    const tooNew = row({
      id: 'too-new',
      markdown_written_at: NOW - 1 * ONE_DAY_MS,
    });
    const eligible = row({
      id: 'eligible',
      markdown_written_at: NOW - 30 * ONE_DAY_MS,
    });
    const wrongStatus = row({
      id: 'wrong-status',
      status: 'error',
      markdown_written_at: NOW - 30 * ONE_DAY_MS,
    });
    const state = fakeState([tooNew, eligible, wrongStatus]);
    const unlinked: string[] = [];
    const fs = fakeFs({ unlink: (p) => unlinked.push(p) });

    const result = runSweep(state, 14, fs, silentLogger, NOW);

    expect(result.considered).toBe(3);
    expect(unlinked).toEqual([eligible.audio_path]);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0]!.id).toBe('eligible');
    expect(state.updates).toEqual([
      { id: 'eligible', patch: { audio_path: null } },
    ]);
  });
});
