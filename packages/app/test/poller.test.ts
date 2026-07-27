import { describe, it, expect } from 'vitest';
import { selectInitialInboxIds } from '../src/main/poller.js';
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
