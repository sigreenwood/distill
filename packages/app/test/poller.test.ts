import { describe, it, expect } from 'vitest';
import { selectInitialInboxIds } from '../src/main/poller.js';
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
