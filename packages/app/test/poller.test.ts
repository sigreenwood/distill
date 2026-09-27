import { describe, it, expect } from 'vitest';
import { LEGACY_LIST_LIMIT, Poller, selectInitialInboxIds } from '../src/main/poller.js';
import { stepPlanFor } from '../src/main/state.js';
import type { RecordingRow } from '../src/main/state.js';
import type { PlaudRecording } from '@plaud/core';

function rec(id: string, startTime: number): PlaudRecording {
  return { id, start_time: startTime } as PlaudRecording;
}

describe('selectInitialInboxIds', () => {
  // Deliberately out of order — Plaud does not guarantee sorted output.
  const recordings = [
    rec('old', 1_000),
    rec('newest', 5_000),
    rec('middle', 3_000),
    rec('oldest', 500),
    rec('second', 4_000),
  ];

  it('keeps the N most recent by start time', () => {
    const ids = selectInitialInboxIds(recordings, 2);
    expect(ids).toEqual(new Set(['newest', 'second']));
  });

  it('skips everything when the count is 0 (original behaviour)', () => {
    expect(selectInitialInboxIds(recordings, 0).size).toBe(0);
  });

  it('keeps everything when the count exceeds the library size', () => {
    expect(selectInitialInboxIds(recordings, 99).size).toBe(recordings.length);
  });

  it('treats a missing start time as oldest rather than throwing', () => {
    const withMissing = [...recordings, { id: 'undated' } as PlaudRecording];
    const ids = selectInitialInboxIds(withMissing, 2);
    expect(ids.has('undated')).toBe(false);
    expect(ids).toEqual(new Set(['newest', 'second']));
  });

  it('does not mutate the caller\'s array', () => {
    const input = [...recordings];
    selectInitialInboxIds(input, 3);
    expect(input.map((r) => r.id)).toEqual(recordings.map((r) => r.id));
  });
});

describe('stepPlanFor', () => {
  const base = { source: 'plaud', audio_path: null, transcript_text: null } as unknown as RecordingRow;

  it('gives a Plaud recording all four steps', () => {
    expect(stepPlanFor(base)).toEqual(['download', 'transcribe', 'summarise', 'write']);
  });

  it('skips download for a dragged-in audio file', () => {
    const local = { ...base, source: 'local', audio_path: '/a.mp3' } as RecordingRow;
    expect(stepPlanFor(local)).toEqual(['transcribe', 'summarise', 'write']);
  });

  it('gives an imported transcript only two steps', () => {
    // The whole point of transcript re-import is skipping the expensive
    // half; the progress counter should say so rather than claiming 4.
    const imported = {
      ...base,
      source: 'local',
      audio_path: null,
      transcript_text: 'words',
    } as RecordingRow;
    expect(stepPlanFor(imported)).toEqual(['summarise', 'write']);
  });

  it('keeps download in the plan for a Plaud row already downloaded', () => {
    // Total must stay stable as a row progresses, or the counter would
    // renumber itself mid-flight.
    const mid = { ...base, audio_path: '/a.mp3' } as RecordingRow;
    expect(stepPlanFor(mid)).toHaveLength(4);
  });
});

describe('Poller full-history backfill', () => {
  // Minimal stand-in for State: only what Poller.tick touches.
  function fakeState(known: string[], appState: Record<string, string>) {
    const rows = new Map<string, string>(known.map((id) => [id, 'skipped']));
    return {
      rows,
      state: {
        getAppState: (k: string) => appState[k],
        setAppState: (k: string, v: string) => {
          appState[k] = v;
        },
        recordingExists: (id: string) => rows.has(id),
        insertRecording: (r: { id: string; status: string }) => {
          rows.set(r.id, r.status);
        },
      },
    };
  }
  const logger = { info() {}, warn() {}, error() {}, debug() {} };

  function pollerFor(all: PlaudRecording[], state: unknown, onPoll = () => {}) {
    return new Poller({
      client: { listRecordings: async () => all } as never,
      state: state as never,
      logger: logger as never,
      intervalMinutes: 5,
      shouldPause: () => false,
      onPoll,
    } as never);
  }

  // LEGACY_LIST_LIMIT + 2 recordings, newest first by start time.
  const all = Array.from({ length: LEGACY_LIST_LIMIT + 2 }, (_, i) =>
    rec(`r${i}`, 1_000_000 - i),
  );

  it('hides recordings older than the old 1000-row window on the first full-history poll', async () => {
    // Everything the old listing could see is known, except the newest
    // (genuinely new since the last poll).
    const known = all.slice(1, LEGACY_LIST_LIMIT).map((r) => r.id);
    const { rows, state } = fakeState(known, { hasCompletedInitialPoll: 'true' });
    let fresh: PlaudRecording[] = [];
    await pollerFor(all, state, ((_r: unknown, f: PlaudRecording[]) => (fresh = f)) as never).syncNow();

    expect(rows.get('r0')).toBe('inbox');
    expect(fresh.map((r) => r.id)).toEqual(['r0']);
    expect(rows.get(`r${LEGACY_LIST_LIMIT}`)).toBe('skipped');
    expect(rows.get(`r${LEGACY_LIST_LIMIT + 1}`)).toBe('skipped');
  });

  it('treats every unseen recording as new once the backfill has happened', async () => {
    const { rows, state } = fakeState([], {
      hasCompletedInitialPoll: 'true',
      hasBackfilledFullHistory: 'true',
    });
    await pollerFor(all, state).syncNow();
    expect(rows.get(`r${LEGACY_LIST_LIMIT + 1}`)).toBe('inbox');
  });

  it('marks the backfill done after the first poll', async () => {
    const appState: Record<string, string> = { hasCompletedInitialPoll: 'true' };
    const { state } = fakeState([], appState);
    await pollerFor(all, state).syncNow();
    expect(appState.hasBackfilledFullHistory).toBe('true');
  });
});
