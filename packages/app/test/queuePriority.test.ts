import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { State } from '../src/main/state.js';

// Exercise the real claim SQL with Node's SQLite, avoiding the native
// better-sqlite3 binary that is built for Electron in this workspace.
describe('recording queue priority', () => {
  let db: DatabaseSync;
  let state: State;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE recordings (
      id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'tagged',
      urgent INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL,
      updated_at INTEGER, audio_path TEXT, transcript_text TEXT, summary_text TEXT
    )`);
    state = new State({
      prepare: db.prepare.bind(db),
      transaction: (fn: () => unknown) => () => {
        db.exec('BEGIN');
        try {
          const result = fn();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      },
    } as unknown as ConstructorParameters<typeof State>[0]);
  });

  afterEach(() => db.close());

  const add = (id: string, syncedAt: number, urgent = 0) => {
    db.prepare('INSERT INTO recordings (id, synced_at, urgent) VALUES (?, ?, ?)').run(id, syncedAt, urgent);
  };

  it('claims urgent recordings before older ordinary recordings, FIFO within each priority', () => {
    add('ordinary-old', 1);
    add('ordinary-new', 2);
    add('urgent-old', 3, 1);
    add('urgent-new', 4, 1);
    expect(Array.from({ length: 4 }, () => state.claimNextTagged()?.id)).toEqual([
      'urgent-old', 'urgent-new', 'ordinary-old', 'ordinary-new',
    ]);
    expect(state.claimNextTagged()).toBeUndefined();
  });

  it('honours urgency set during a batch on the next claim, leaving active work untouched', () => {
    add('active', 1);
    add('waiting', 2);
    add('need-now', 3);
    expect(state.claimNextTagged()?.id).toBe('active');
    expect(state.setUrgent('need-now', true)).toBe(true);
    expect(state.claimNextTagged()?.id).toBe('need-now');
    expect(state.getRecording('active')?.status).toBe('downloading');
    expect(state.claimNextTagged()?.id).toBe('waiting');
  });

  it('restores ordinary FIFO order when urgency is removed before claiming', () => {
    add('old', 1);
    add('new', 2, 1);
    state.setUrgent('new', false);
    expect(state.claimNextTagged()?.id).toBe('old');
  });

  it('does not let urgency bypass a paused step', () => {
    add('urgent-download', 1, 1);
    add('ready-to-transcribe', 2);
    db.prepare('UPDATE recordings SET audio_path = ? WHERE id = ?').run('/tmp/audio.mp3', 'ready-to-transcribe');
    expect(state.claimNextTagged(new Set(['transcribe']))?.id).toBe('ready-to-transcribe');
    expect(state.getRecording('urgent-download')?.status).toBe('tagged');
  });

  it('retains schedule bypass for urgent work and ready-to-write rows only', () => {
    add('ordinary', 1);
    add('ready-to-write', 2);
    add('urgent', 3, 1);
    db.prepare('UPDATE recordings SET transcript_text = ?, summary_text = ? WHERE id = ?')
      .run('transcript', 'summary', 'ready-to-write');
    expect(state.claimNextTagged(undefined, true)?.id).toBe('urgent');
    expect(state.claimNextTagged(undefined, true)?.id).toBe('ready-to-write');
    expect(state.claimNextTagged(undefined, true)).toBeUndefined();
    expect(state.getRecording('ordinary')?.status).toBe('tagged');
  });
});
