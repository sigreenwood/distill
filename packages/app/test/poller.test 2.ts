import { describe, it, expect, beforeEach } from 'vitest';
import { Poller, type PlaudListClient, type InboxStore, INITIAL_POLL_KEY } from '../src/main/poller.js';
import pino from 'pino';
import type { PlaudRecording } from '@plaud/core';
import type { RecordingRow } from '../src/main/state.js';

/**
 * Tests deliberately avoid better-sqlite3 so they run under whichever Node
 * version vitest is launched with, regardless of which Node/Electron ABI
 * the native module was last built for. A hand-rolled in-memory store
 * satisfies the InboxStore interface and is faster besides.
 */

function makeRecording(overrides: Partial<PlaudRecording> = {}): PlaudRecording {
  return {
    id: 'rec-1',
    filename: 'Meeting.mp3',
    fullname: 'Meeting.mp3',
    filesize: 1_234_567,
    duration: 1800,
    start_time: 1_700_000_000,
    end_time: 1_700_001_800,
    is_trash: false,
    is_trans: true,
    is_summary: false,
    keywords: [],
    serial_number: 'SN-1',
    ...overrides,
  };
}

class FakeInboxStore implements InboxStore {
  private ids = new Set<string>();
  private kv = new Map<string, string>();
  readonly inserted: Array<Omit<RecordingRow, 'created_at' | 'updated_at' | 'retries'>> = [];

  recordingExists(id: string): boolean {
    return this.ids.has(id);
  }

  insertRecording(r: Omit<RecordingRow, 'created_at' | 'updated_at' | 'retries'>): void {
    if (this.ids.has(r.id)) throw new Error(`duplicate insert for id=${r.id}`);
    this.ids.add(r.id);
    this.inserted.push(r);
  }

  getAppState(key: string): string | undefined {
    return this.kv.get(key);
  }

  setAppState(key: string, value: string): void {
    this.kv.set(key, value);
  }

  size(): number {
    return this.ids.size;
  }

  /**
   * Pre-mark the initial poll as complete so tests that want normal inbox
   * behaviour don't have to simulate the first-launch catch-up path.
   */
  markInitialPollComplete(): void {
    this.kv.set(INITIAL_POLL_KEY, 'true');
  }
}

class FakeClient implements PlaudListClient {
  private queue: Array<PlaudRecording[] | Error> = [];
  calls = 0;

  queueResult(list: PlaudRecording[]): void {
    this.queue.push(list);
  }

  queueError(e: Error): void {
    this.queue.push(e);
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    this.calls++;
    const next = this.queue.shift();
    if (next === undefined) throw new Error('FakeClient: no more queued results');
    if (next instanceof Error) throw next;
    return next;
  }
}

describe('Poller.syncNow', () => {
  const silentLogger = pino({ level: 'silent' });

  let state: FakeInboxStore;
  let client: FakeClient;

  beforeEach(() => {
    state = new FakeInboxStore();
    // Default: most tests want normal inbox behaviour, not first-launch
    // catch-up. Individual tests override this when testing the initial poll.
    state.markInitialPollComplete();
    client = new FakeClient();
  });

  it('inserts new recordings as inbox and reports newCount', async () => {
    client.queueResult([makeRecording({ id: 'a' }), makeRecording({ id: 'b', filename: 'Second.mp3' })]);

    const seen: Array<{ result: unknown; fresh: PlaudRecording[] }> = [];
    const poller = new Poller({
      state,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: (result, fresh) => seen.push({ result, fresh }),
    });

    const result = await poller.syncNow();

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.newCount).toBe(2);
      expect(result.totalSeen).toBe(2);
    }
    expect(state.size()).toBe(2);
    expect(state.inserted.map((r) => r.status)).toEqual(['inbox', 'inbox']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.fresh.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('does not re-insert recordings that already exist', async () => {
    client.queueResult([makeRecording({ id: 'a' })]);
    client.queueResult([makeRecording({ id: 'a' }), makeRecording({ id: 'b' })]);

    const poller = new Poller({
      state,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: () => {},
    });

    await poller.syncNow();
    expect(state.size()).toBe(1);

    const second = await poller.syncNow();
    expect(state.size()).toBe(2);
    if (second.kind === 'ok') expect(second.newCount).toBe(1);
  });

  it('skips when paused', async () => {
    client.queueResult([makeRecording({ id: 'a' })]);

    const poller = new Poller({
      state,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => true,
      onPoll: () => {},
    });

    const result = await poller.syncNow();
    expect(result.kind).toBe('skipped-paused');
    expect(state.size()).toBe(0);
    expect(client.calls).toBe(0);
  });

  it('reports error without throwing and keeps state consistent', async () => {
    client.queueError(new Error('network down'));

    const poller = new Poller({
      state,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: () => {},
    });

    const result = await poller.syncNow();
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toBe('network down');
    expect(state.size()).toBe(0);
  });

  it('onPoll fires for every attempt regardless of outcome', async () => {
    client.queueResult([makeRecording({ id: 'a' })]);
    client.queueError(new Error('transient'));

    const calls: string[] = [];
    const poller = new Poller({
      state,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: (r) => calls.push(r.kind),
    });

    await poller.syncNow();
    await poller.syncNow();

    expect(calls).toEqual(['ok', 'error']);
  });

  it('first-ever poll marks all existing recordings as skipped', async () => {
    // Fresh install — no initial-poll flag set yet.
    const fresh = new FakeInboxStore();
    client.queueResult([
      makeRecording({ id: 'old-1' }),
      makeRecording({ id: 'old-2' }),
      makeRecording({ id: 'old-3' }),
    ]);

    const notified: PlaudRecording[][] = [];
    const poller = new Poller({
      state: fresh,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: (_result, fresh) => notified.push(fresh),
    });

    const result = await poller.syncNow();

    expect(result.kind).toBe('ok');
    expect(fresh.size()).toBe(3);
    // Everything stored as skipped, not inbox.
    expect(fresh.inserted.map((r) => r.status)).toEqual(['skipped', 'skipped', 'skipped']);
    // No user-facing notifications for catch-up.
    expect(notified).toEqual([[]]);
    // Flag now set so subsequent polls use the normal path.
    expect(fresh.getAppState(INITIAL_POLL_KEY)).toBe('true');
  });

  it('second poll after initial catch-up places new recordings into inbox', async () => {
    const fresh = new FakeInboxStore();
    // First poll returns history — gets skipped.
    client.queueResult([makeRecording({ id: 'old-1' }), makeRecording({ id: 'old-2' })]);
    // Second poll returns a genuinely new one.
    client.queueResult([
      makeRecording({ id: 'old-1' }),
      makeRecording({ id: 'old-2' }),
      makeRecording({ id: 'new-today', filename: 'Today call.mp3' }),
    ]);

    const notified: PlaudRecording[] = [];
    const poller = new Poller({
      state: fresh,
      client,
      intervalMinutes: 5,
      logger: silentLogger,
      shouldPause: () => false,
      onPoll: (_result, fresh) => notified.push(...fresh),
    });

    await poller.syncNow();
    await poller.syncNow();

    const inserted = fresh.inserted;
    expect(inserted.find((r) => r.id === 'old-1')!.status).toBe('skipped');
    expect(inserted.find((r) => r.id === 'old-2')!.status).toBe('skipped');
    expect(inserted.find((r) => r.id === 'new-today')!.status).toBe('inbox');
    // Only the new-today recording triggers a notification.
    expect(notified.map((r) => r.id)).toEqual(['new-today']);
  });

  describe('cross-machine completion lookup', () => {
    it('inserts a recording as complete when its id is in the processed-elsewhere map', async () => {
      client.queueResult([
        makeRecording({ id: 'rec-fresh' }),
        makeRecording({ id: 'rec-already-done', filename: 'Done.mp3' }),
      ]);

      const seen: PlaudRecording[][] = [];
      const poller = new Poller({
        state,
        client,
        intervalMinutes: 5,
        logger: silentLogger,
        shouldPause: () => false,
        loadProcessedElsewhere: async () =>
          new Map([
            [
              'rec-already-done',
              {
                markdownPath: '/iCloud/Acme Corp/done.md',
                writtenAtMs: 1735000000000,
                modelSnapshot: 'qwen2.5:14b',
                whisperSnapshot: 'mlx-community/whisper-small-mlx',
              },
            ],
          ]),
        onPoll: (_r, fresh) => seen.push(fresh),
      });

      await poller.syncNow();

      const fresh = state.inserted.find((r) => r.id === 'rec-fresh');
      const done = state.inserted.find((r) => r.id === 'rec-already-done');

      expect(fresh?.status).toBe('inbox');
      expect(fresh?.processed_externally).toBe(0);

      expect(done?.status).toBe('complete');
      expect(done?.processed_externally).toBe(1);
      expect(done?.markdown_path).toBe('/iCloud/Acme Corp/done.md');
      expect(done?.markdown_written_at).toBe(1735000000000);
      expect(done?.model_snapshot).toBe('qwen2.5:14b');
      expect(done?.whisper_snapshot).toBe('mlx-community/whisper-small-mlx');

      // Only the genuinely-new recording should appear in the
      // notifications list — the cross-machine import is silent.
      expect(seen[0]!.map((r) => r.id)).toEqual(['rec-fresh']);
    });

    it('treats a missing loadProcessedElsewhere as no-cross-machine-detection', async () => {
      // Existing tests already exercise this path implicitly. Pin it
      // explicitly here so a future refactor that makes the option
      // mandatory triggers a clear test failure.
      client.queueResult([makeRecording({ id: 'rec-1' })]);
      const poller = new Poller({
        state,
        client,
        intervalMinutes: 5,
        logger: silentLogger,
        shouldPause: () => false,
        // intentionally omitted: loadProcessedElsewhere
        onPoll: () => {},
      });
      await poller.syncNow();
      expect(state.inserted[0]!.status).toBe('inbox');
      expect(state.inserted[0]!.processed_externally).toBe(0);
    });

    it('falls back to single-machine behaviour when the lookup throws', async () => {
      client.queueResult([makeRecording({ id: 'rec-1' })]);
      const poller = new Poller({
        state,
        client,
        intervalMinutes: 5,
        logger: silentLogger,
        shouldPause: () => false,
        loadProcessedElsewhere: async () => {
          throw new Error('I/O error scanning iCloud Drive');
        },
        onPoll: () => {},
      });
      const result = await poller.syncNow();
      // The poll itself succeeds despite the lookup error.
      expect(result.kind).toBe('ok');
      // The recording lands in inbox as today.
      expect(state.inserted[0]!.status).toBe('inbox');
      expect(state.inserted[0]!.processed_externally).toBe(0);
    });

    it('initial-poll catch-up still skips, even for recordings found in the lookup', async () => {
      // Without this guard, the very first poll on a fresh M5 install
      // would adopt every cross-machine output as `complete` instead
      // of skipping the entire history. The user-facing intent of
      // the initial-poll skip is "don't notify me about old stuff",
      // which we honour here even when we know the row is done.
      const fresh = new FakeInboxStore();
      client.queueResult([
        makeRecording({ id: 'old-1' }),
        makeRecording({ id: 'old-2' }),
      ]);
      const poller = new Poller({
        state: fresh,
        client,
        intervalMinutes: 5,
        logger: silentLogger,
        shouldPause: () => false,
        loadProcessedElsewhere: async () =>
          new Map([
            [
              'old-2',
              {
                markdownPath: '/iCloud/foo.md',
                writtenAtMs: 1735000000000,
                modelSnapshot: 'qwen2.5:32b',
                whisperSnapshot: null,
              },
            ],
          ]),
        onPoll: () => {},
      });
      await poller.syncNow();
      // Both rows skipped — the cross-machine signal does NOT
      // override the initial-poll catch-up.
      expect(fresh.inserted.map((r) => r.status)).toEqual(['skipped', 'skipped']);
      expect(fresh.inserted.every((r) => r.processed_externally === 0)).toBe(true);
    });
  });
});
