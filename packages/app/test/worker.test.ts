import { describe, it, expect, vi } from 'vitest';
import { Worker } from '../src/main/worker.js';
import type { PipelineContext } from '../src/main/pipelineSteps.js';
import type { AppConfig } from '../src/main/config.js';
import type { RecordingRow, RecordingStatus } from '../src/main/state.js';

// The worker loop against an in-memory fake State — no SQLite (see
// CLAUDE.md's better-sqlite3 ABI note). Each case starts the run with the
// recording's next step already decided, so nothing reaches a subprocess.
function setup(row: Partial<RecordingRow>, pausedAfterClaim: Partial<AppConfig['paused']>) {
  const rec = { id: 'r1', status: 'tagged' as RecordingStatus, ...row } as RecordingRow;
  let claimed = false;
  const statuses: RecordingStatus[] = [];
  const state = {
    claimNextTagged: () => {
      if (claimed) return undefined;
      claimed = true;
      return { ...rec };
    },
    getRecording: () => ({ ...rec }),
    setStatus: (_id: string, status: RecordingStatus, patch?: Partial<RecordingRow>) => {
      rec.status = status;
      Object.assign(rec, patch);
      statuses.push(status);
    },
  };
  const unpaused = { all: false, polling: false, download: false, transcribe: false, summarise: false };
  let configReads = 0;
  // The first read is the claim; later reads see the step paused, as if
  // the user paused it from the tray between claim and step start.
  const getConfig = () =>
    ({
      paused: configReads++ === 0 ? unpaused : { ...unpaused, ...pausedAfterClaim },
      processingSchedule: { mode: 'immediate', idleMinutes: 15, overnightStart: '22:00', overnightEnd: '06:00' },
    }) as AppConfig;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const onComplete = vi.fn();
  const worker = new Worker(
    { state, getConfig, logger } as unknown as PipelineContext,
    { onStateChanged: vi.fn(), onComplete },
  );
  const run = () => (worker as unknown as { loop: () => Promise<void> }).loop();
  return { rec, statuses, onComplete, run };
}

describe('Worker', () => {
  it('leaves a recording queued, not complete, when its step is paused after the claim', async () => {
    const { rec, onComplete, run } = setup(
      { audio_path: '/tmp/a.mp3', transcript_text: null, summary_text: null },
      { transcribe: true },
    );
    await run();
    expect(rec.status).toBe('tagged');
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('leaves a "Queue all" recording waiting to be filed, not complete', async () => {
    const { rec, onComplete, run } = setup(
      { audio_path: '/tmp/a.mp3', transcript_text: 'text', summary_text: 'summary', needs_filing: 1 },
      {},
    );
    await run();
    expect(rec.status).toBe('to_file');
    expect(onComplete).not.toHaveBeenCalled();
  });
});
