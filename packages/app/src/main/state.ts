import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stateDbFile } from './paths.js';

export type RecordingStatus =
  | 'inbox'
  | 'tagged'
  | 'downloading'
  | 'transcribing'
  | 'summarising'
  | 'writing'
  | 'complete'
  | 'error'
  | 'cancelled'
  | 'skipped';

export type RecordingSource = 'plaud' | 'local';

export type PipelineStep = 'download' | 'transcribe' | 'summarise' | 'write';

export interface RecordingRow {
  id: string;
  filename: string;
  duration_seconds: number | null;
  start_time: number | null;
  filesize_bytes: number | null;
  synced_at: number;
  status: RecordingStatus;
  client_id: string | null;
  meeting_type_id: string | null;
  audio_path: string | null;
  transcript_text: string | null;
  summary_text: string | null;
  markdown_path: string | null;
  error: string | null;
  is_auth_error: number;
  last_step: string | null;
  retries: number;
  prompt_snapshot: string | null;
  model_snapshot: string | null;
  whisper_snapshot: string | null;
  vocabulary_sources: string | null;
  vocabulary_rules_applied: number | null;
  html_path: string | null;
  apple_note_id: string | null;
  source: RecordingSource;
  markdown_written_at: number | null;
  html_written_at: number | null;
  apple_note_written_at: number | null;
  truncation_warning: number;
  estimated_input_tokens: number | null;
  context_window_at_submit: number | null;
  processed_externally: number;
  created_at: number;
  updated_at: number;
}

export interface JoinedRecordingRow extends RecordingRow {
  client_name: string | null;
  meeting_type_name: string | null;
}

export interface ClientRow {
  id: string;
  name: string;
  is_builtin: number;
  sort_order: number;
  created_at: number;
}

export interface MeetingTypeRow {
  id: string;
  name: string;
  prompt: string;
  is_builtin: number;
  sort_order: number;
  original_prompt_hash: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProcessingSummary {
  currentStatus: RecordingStatus | null;
  running: number;
  queued: number;
}

export type DeleteMeetingTypeResult =
  | { kind: 'deleted'; detachedCount: number }
  | { kind: 'not-found' }
  | { kind: 'builtin' };

export function nextNeededStep(row: RecordingRow): PipelineStep {
  if (!row.audio_path) return 'download';
  if (!row.transcript_text) return 'transcribe';
  if (!row.summary_text) return 'summarise';
  return 'write';
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE recordings (
        id                TEXT PRIMARY KEY,
        filename          TEXT NOT NULL,
        duration_seconds  INTEGER,
        start_time        INTEGER,
        filesize_bytes    INTEGER,
        synced_at         INTEGER NOT NULL,
        status            TEXT NOT NULL,
        client_id         TEXT REFERENCES clients(id),
        meeting_type_id   TEXT REFERENCES meeting_types(id),
        audio_path        TEXT,
        transcript_text   TEXT,
        summary_text      TEXT,
        markdown_path     TEXT,
        error             TEXT,
        last_step         TEXT,
        retries           INTEGER NOT NULL DEFAULT 0,
        prompt_snapshot   TEXT,
        model_snapshot    TEXT,
        whisper_snapshot  TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE clients (
        id          TEXT PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL
      );

      CREATE TABLE meeting_types (
        id          TEXT PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        prompt      TEXT NOT NULL,
        is_builtin  INTEGER NOT NULL DEFAULT 0,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE INDEX idx_recordings_status    ON recordings(status);
      CREATE INDEX idx_recordings_synced_at ON recordings(synced_at DESC);
    `,
  },
  {
    version: 2,
    sql: `
      -- Tracks whether this install has ever had a successful first poll.
      -- The poller uses this to decide whether to place new recordings into
      -- the inbox (normal) or the skipped bucket (catch-up on first launch).
      CREATE TABLE app_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    sql: `
      -- Record which vocabulary files were merged for this recording and
      -- how many replacement rules actually fired on its transcript. Used
      -- for transparency in the Markdown frontmatter, the inbox UI, and
      -- debugging when a correction goes wrong.
      ALTER TABLE recordings ADD COLUMN vocabulary_sources TEXT;
      ALTER TABLE recordings ADD COLUMN vocabulary_rules_applied INTEGER;
    `,
  },
  {
    version: 4,
    sql: `
      -- Distinguishes recordings pulled from Plaud cloud from ones the user
      -- dragged in from disk (Teams recordings, Zoom exports, voice memos).
      -- Locally imported rows have their audio_path set at insert time and
      -- skip the download step.
      ALTER TABLE recordings ADD COLUMN source TEXT NOT NULL DEFAULT 'plaud';
    `,
  },
  {
    version: 5,
    sql: `
      -- Support for multiple output destinations: Markdown (existing,
      -- tracked via markdown_path), HTML file (new), and Apple Notes
      -- (new, tracked by note id). Each is nullable so a row's columns
      -- reflect exactly which destinations were successfully written.
      ALTER TABLE recordings ADD COLUMN html_path TEXT;
      ALTER TABLE recordings ADD COLUMN apple_note_id TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      -- Per-destination completion timestamps. See DECISIONS.md §1.
      --
      -- Previously retry used an "any output written" short-circuit,
      -- which meant: (1) if one destination succeeded and another
      -- failed, the failure was never retried; and (2) if all retries
      -- ran, Apple Notes would produce duplicate notes because it has
      -- no upsert primitive.
      --
      -- These timestamp columns let the write step run only the
      -- destinations that haven't yet succeeded. Null = not yet written
      -- (either never attempted, or the destination was disabled at the
      -- time). A non-null timestamp means that destination's output has
      -- landed and should not be re-written.
      --
      -- Retries of errored rows leave these timestamps intact — only
      -- destinations that still read null will run. A future
      -- "regenerate outputs" action will explicitly null the columns
      -- the user wants re-written (see BACKLOG).
      ALTER TABLE recordings ADD COLUMN markdown_written_at   INTEGER;
      ALTER TABLE recordings ADD COLUMN html_written_at       INTEGER;
      ALTER TABLE recordings ADD COLUMN apple_note_written_at INTEGER;
    `,
  },
  {
    version: 7,
    sql: `
      -- Prompt modification tracking. See DECISIONS.md §3.
      --
      -- When built-in meeting types are seeded from PROMPTS.md, we
      -- store a hash of the seeded prompt here. The Prompts pane in
      -- Settings compares the current prompt's hash against this
      -- reference to show a "modified from default" badge, and uses
      -- it to gate the "revert to default" action.
      --
      -- This column stays NULL for user-created meeting types — they
      -- have no default to differ from.
      ALTER TABLE meeting_types ADD COLUMN original_prompt_hash TEXT;
    `,
  },
  {
    version: 8,
    sql: `
      -- Whether the most recent error was an authentication failure
      -- (e.g. Plaud token expired and re-login also failed). Set by the
      -- pipeline worker via errorMessages.ts when a rule with
      -- isAuthError matches. The inbox UI surfaces a "Sign in again"
      -- button on rows where this is 1, opening Settings → Sources
      -- directly. Always 0 when status isn't 'error'; cleared on any
      -- retry or re-tag. INTEGER (0/1) for SQLite-friendliness.
      ALTER TABLE recordings ADD COLUMN is_auth_error INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 9,
    sql: `
      -- Token-budget warning, set by the summarise step when input
      -- (prompt + transcript) exceeds the effective context budget
      -- (num_ctx minus a reserved chunk for the model's output). When
      -- 1, Ollama will silently truncate the start of the input and
      -- produce a partial summary. The inbox surfaces this as a
      -- yellow badge on the completed row.
      --
      -- See pipeline/steps.ts::doSummarise. Existing complete rows
      -- get 0 / NULL on migrate — we don't retroactively warn for
      -- rows summarised before the check existed (the UI would be
      -- noisy and the underlying summary is already on disk).
      ALTER TABLE recordings ADD COLUMN truncation_warning      INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE recordings ADD COLUMN estimated_input_tokens  INTEGER;
      ALTER TABLE recordings ADD COLUMN context_window_at_submit INTEGER;
    `,
  },
  {
    version: 10,
    sql: `
      -- Cross-machine completion flag. When 1, the row was inserted
      -- as 'complete' because another machine had already processed
      -- the recording (markdown file with matching recording_id
      -- found in the configured output dir). The pipeline never ran
      -- for this row on this machine — transcript_text, summary_text,
      -- error are all NULL; markdown_path / markdown_written_at /
      -- model_snapshot / whisper_snapshot reflect the file found.
      --
      -- The inbox UI surfaces a "processed on another machine" hint
      -- with the model name on these rows so the user knows the
      -- summary may have been produced with a different model than
      -- this machine would use today (a 48GB+ Mac runs qwen2.5:32b; a
      -- 24GB Mac runs qwen2.5:14b).
      --
      -- See poller.ts and processedElsewhere.ts. Existing rows
      -- migrate with the default 0 (this-machine) since we have no
      -- way to know retrospectively whether they were copied or
      -- locally produced.
      ALTER TABLE recordings ADD COLUMN processed_externally INTEGER NOT NULL DEFAULT 0;
    `,
  },
];

export function openDatabase(_path?: string): Database.Database {
  const dbPath = stateDbFile();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare('SELECT version FROM migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(
      m.version,
      Date.now(),
    );
  });
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      apply(m);
    }
  }
}

export class State {
  db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  close(): void {
    this.db.close();
  }

  // --- clients -------------------------------------------------------------

  listClients(): ClientRow[] {
    return this.db.prepare('SELECT * FROM clients ORDER BY sort_order, name').all() as ClientRow[];
  }

  getClient(id: string): ClientRow | undefined {
    return this.db.prepare('SELECT * FROM clients WHERE id = ?').get(id) as ClientRow | undefined;
  }

  upsertClient(row: Omit<ClientRow, 'created_at'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO clients (id, name, is_builtin, sort_order, created_at)
         VALUES (@id, @name, @is_builtin, @sort_order, @created_at)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order`,
      )
      .run({ ...row, created_at: now });
  }

  // --- meeting types -------------------------------------------------------

  listMeetingTypes(): MeetingTypeRow[] {
    return this.db
      .prepare('SELECT * FROM meeting_types ORDER BY sort_order, name')
      .all() as MeetingTypeRow[];
  }

  getMeetingType(id: string): MeetingTypeRow | undefined {
    return this.db.prepare('SELECT * FROM meeting_types WHERE id = ?').get(id) as
      | MeetingTypeRow
      | undefined;
  }

  upsertMeetingType(row: Omit<MeetingTypeRow, 'created_at' | 'updated_at'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO meeting_types (
           id, name, prompt, is_builtin, sort_order,
           original_prompt_hash, created_at, updated_at
         ) VALUES (
           @id, @name, @prompt, @is_builtin, @sort_order,
           @original_prompt_hash, @created_at, @updated_at
         )
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name,
           prompt=excluded.prompt,
           sort_order=excluded.sort_order,
           updated_at=excluded.updated_at`,
      )
      .run({ ...row, created_at: now, updated_at: now });
  }

  /**
   * Delete a user-created meeting type. Refuses to delete built-ins
   * (they would be re-seeded on next launch from PROMPTS.md, so a
   * delete would silently un-do itself).
   *
   * For user-created types, ANY referencing recordings have their
   * `meeting_type_id` NULL'd before the prompt is removed. Their
   * `prompt_snapshot` field still holds the actual prompt text the
   * row was summarised with, so the original prompt is preserved on
   * the historical row even after the meeting_type record is gone.
   * What's lost is the joined `meeting_type_name` in the inbox/UI;
   * that field reads as null on detached rows. The Markdown frontmatter
   * already has the meeting_type name baked in at write time, so on-
   * disk artefacts are unaffected.
   *
   * Earlier behaviour refused delete when ANY row referenced the type
   * (history-protective, BUT meant test prompts couldn't be cleaned
   * up after a single trial run). The current shape trades a little
   * UI history for the ability to actually cull experimental prompts.
   * For built-ins the Revert action remains the right knob; for user
   * prompts, delete = gone.
   *
   * Returns a discriminated result so callers can render the right
   * error message without parsing exception text:
   *
   *   - `{ kind: 'deleted', detachedCount }` — row removed; N existing
   *                                            recordings had their
   *                                            meeting_type_id NULL'd.
   *   - `{ kind: 'not-found' }`              — no such id.
   *   - `{ kind: 'builtin' }`                — id refers to a seeded type.
   *
   * The detach + DELETE run inside one transaction so a concurrent
   * insert can't leak a row referencing the just-deleted type. (In
   * practice the renderer only edits state from the main thread, but
   * the transaction is cheap and makes the contract trivially correct.)
   */
  deleteMeetingType(id: string): DeleteMeetingTypeResult {
    return this.db.transaction((): DeleteMeetingTypeResult => {
      const existing = this.db.prepare('SELECT is_builtin FROM meeting_types WHERE id = ?').get(id) as
        | { is_builtin: number }
        | undefined;
      if (!existing) return { kind: 'not-found' };
      if (existing.is_builtin === 1) return { kind: 'builtin' };
      const detach = this.db
        .prepare('UPDATE recordings SET meeting_type_id = NULL WHERE meeting_type_id = ?')
        .run(id);
      const detachedCount = detach.changes ?? 0;
      this.db.prepare('DELETE FROM meeting_types WHERE id = ?').run(id);
      return { kind: 'deleted', detachedCount };
    })();
  }

  /**
   * Edit an existing meeting type's name and/or prompt. Leaves
   * `is_builtin`, `sort_order`, and `original_prompt_hash` alone — the
   * hash is the seed reference, not the current state. See
   * DECISIONS.md §3 for why the hash doesn't rotate on user edits.
   *
   * Bumps `updated_at`. Returns true iff a row was updated.
   */
  updateMeetingType(id: string, patch: { name?: string; prompt?: string }): boolean {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };
    if (patch.name !== undefined) {
      fields.push('name = @name');
      params.name = patch.name;
    }
    if (patch.prompt !== undefined) {
      fields.push('prompt = @prompt');
      params.prompt = patch.prompt;
    }
    if (fields.length === 0) return false;
    fields.push('updated_at = @updated_at');
    const result = this.db
      .prepare(`UPDATE meeting_types SET ${fields.join(', ')} WHERE id = @id`)
      .run(params);
    return result.changes > 0;
  }

  /**
   * Revert a built-in meeting type to its shipped default prompt, AND
   * resync `original_prompt_hash` to the hash of that prompt.
   *
   * Why this isn't just `updateMeetingType({ prompt: seeded })`: revert
   * is the canonical "reset everything to factory defaults" action, and
   * that includes the hash reference. Without this, pre-migration-7
   * installs (where `original_prompt_hash` was NULL on every existing
   * row) would never light up the "modified from default" badge after
   * an edit, because the NULL check in `toMeetingTypeDTO` returns false
   * regardless of what the prompt actually says.
   *
   * Logically: `updateMeetingType` says "the user changed something";
   * `revertMeetingTypeToBuiltin` says "this row IS the default again".
   * The hash captures the latter intent.
   *
   * Bumps `updated_at`. Returns true iff a row was updated.
   */
  revertMeetingTypeToBuiltin(id: string, seededPrompt: string, seededPromptHash: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE meeting_types
         SET prompt = @prompt,
             original_prompt_hash = @hash,
             updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id,
        prompt: seededPrompt,
        hash: seededPromptHash,
        updated_at: Date.now(),
      });
    return result.changes > 0;
  }

  // --- recordings ----------------------------------------------------------

  recordingExists(id: string): boolean {
    const hit = this.db.prepare('SELECT 1 as one FROM recordings WHERE id = ?').get(id);
    return hit !== undefined;
  }

  insertRecording(r: Omit<RecordingRow, 'retries' | 'created_at' | 'updated_at'>): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO recordings (
           id, filename, duration_seconds, start_time, filesize_bytes, synced_at,
           status, client_id, meeting_type_id, audio_path, transcript_text, summary_text,
           markdown_path, error, is_auth_error, last_step, retries, prompt_snapshot, model_snapshot,
           whisper_snapshot, vocabulary_sources, vocabulary_rules_applied,
           html_path, apple_note_id, source,
           markdown_written_at, html_written_at, apple_note_written_at,
           truncation_warning, estimated_input_tokens, context_window_at_submit,
           processed_externally,
           created_at, updated_at
         ) VALUES (
           @id, @filename, @duration_seconds, @start_time, @filesize_bytes, @synced_at,
           @status, @client_id, @meeting_type_id, @audio_path, @transcript_text, @summary_text,
           @markdown_path, @error, @is_auth_error, @last_step, 0, @prompt_snapshot, @model_snapshot,
           @whisper_snapshot, @vocabulary_sources, @vocabulary_rules_applied,
           @html_path, @apple_note_id, @source,
           @markdown_written_at, @html_written_at, @apple_note_written_at,
           @truncation_warning, @estimated_input_tokens, @context_window_at_submit,
           @processed_externally,
           @created_at, @updated_at
         )`,
      )
      .run({ ...r, created_at: now, updated_at: now });
  }

  updateRecording(id: string, patch: Partial<RecordingRow>): void {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(`UPDATE recordings SET ${set}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, id, updated_at: Date.now() });
  }

  listInbox(): RecordingRow[] {
    return this.db
      .prepare("SELECT * FROM recordings WHERE status = 'inbox' ORDER BY synced_at DESC")
      .all() as RecordingRow[];
  }

  getRecording(id: string): RecordingRow | undefined {
    return this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as
      | RecordingRow
      | undefined;
  }

  /**
   * Mark a recording as skipped — removes it from every UI list. Legal from
   * any terminal or user-actionable state. Not legal from an actively-running
   * pipeline state (use cancel for that).
   */
  skipRecording(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings SET status = 'skipped', updated_at = ?
         WHERE id = ? AND status IN ('inbox', 'error', 'cancelled', 'complete')`,
      )
      .run(Date.now(), id);
    return result.changes > 0;
  }

  // --- pipeline transitions ----------------------------------------------

  /**
   * Unconditionally set status (and optionally other fields) on a recording.
   * Used by the pipeline worker to walk a row through the step states.
   * Callers are expected to already know the current status is valid; this
   * method does not enforce a state machine, only records the transition.
   */
  setStatus(id: string, status: RecordingStatus, patch?: Partial<RecordingRow>): void {
    const now = Date.now();
    const fields = ['status = @status', 'updated_at = @updated_at'];
    const params: Record<string, unknown> = { id, status, updated_at: now };
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = @${k}`);
        params[k] = v;
      }
    }
    this.db.prepare(`UPDATE recordings SET ${fields.join(', ')} WHERE id = @id`).run(params);
  }

  /**
   * Atomically pick the next `tagged` recording to process. Transitions
   * it to the appropriate in-progress status based on which outputs are
   * already populated, so the UI doesn't briefly show "Downloading…"
   * for a row whose audio is already on disk (e.g. a recovered row
   * resuming after a crash, or a locally-imported row whose audio_path
   * was set at insert time).
   *
   * Pause-aware: when `allowedSteps` is provided, only rows whose
   * next-needed step is in the set get claimed. This is how per-step
   * pause is enforced — e.g. with `download` paused but `transcribe`
   * unpaused, rows that already have audio_path set keep moving
   * through the pipeline while not-yet-downloaded rows stay queued
   * at `tagged`. Pass the full set of four steps (or omit the
   * argument) for unrestricted claiming.
   *
   * Returns the row as it looked before the status change, or undefined
   * if nothing is ready (or nothing's next-step is allowed).
   */
  claimNextTagged(allowedSteps?: Set<PipelineStep>): RecordingRow | undefined {
    return this.db.transaction((): RecordingRow | undefined => {
      const rows = this.db
        .prepare(
          `SELECT * FROM recordings
           WHERE status = 'tagged'
           ORDER BY synced_at ASC`,
        )
        .all() as RecordingRow[];
      for (const row of rows) {
        const nextStep = nextNeededStep(row);
        if (allowedSteps && !allowedSteps.has(nextStep)) continue;
        const targetStatus: RecordingStatus =
          nextStep === 'download'
            ? 'downloading'
            : nextStep === 'transcribe'
              ? 'transcribing'
              : nextStep === 'summarise'
                ? 'summarising'
                : 'writing';
        this.db
          .prepare(`UPDATE recordings SET status = ?, updated_at = ? WHERE id = ?`)
          .run(targetStatus, Date.now(), row.id);
        return row;
      }
      return undefined;
    })();
  }

  /**
   * On startup, any recording that is in a pipeline-running state was
   * interrupted (the process running it is gone). Revert them to `tagged`
   * so the worker picks them up again. The idempotent step runner will
   * skip any step whose output field is already populated, so prior work
   * is preserved.
   */
  recoverInterrupted(): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM recordings WHERE status IN ('downloading','transcribing','summarising','writing')`,
      )
      .all() as { id: string }[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const stmt = this.db.prepare(
      `UPDATE recordings SET status = 'tagged', updated_at = ? WHERE id = ?`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    })();
    return ids;
  }

  /**
   * Cancel an active recording. Returns the row as it looked (including its
   * previous status) so callers can clean up partial files. Returns
   * undefined if the row is not in a cancellable state.
   */
  cancel(id: string): RecordingRow | undefined {
    return this.db.transaction((): RecordingRow | undefined => {
      const row = this.db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as
        | RecordingRow
        | undefined;
      if (!row) return undefined;
      const cancellable: RecordingStatus[] = [
        'tagged',
        'downloading',
        'transcribing',
        'summarising',
        'writing',
      ];
      if (!cancellable.includes(row.status)) return undefined;
      this.db
        .prepare(`UPDATE recordings SET status = 'cancelled', updated_at = ? WHERE id = ?`)
        .run(Date.now(), id);
      return row;
    })();
  }

  /**
   * Re-enqueue a recording that is in `error` or `cancelled`. Returns true
   * iff a transition happened.
   *
   * Retry deliberately preserves `*_written_at` timestamps — destinations
   * that already landed don't re-run. See DECISIONS.md §1 for the full
   * contract.
   */
  retry(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET status = 'tagged', error = NULL, is_auth_error = 0, updated_at = ?
         WHERE id = ? AND status IN ('error', 'cancelled')`,
      )
      .run(Date.now(), id);
    return result.changes > 0;
  }

  // --- joined reads ------------------------------------------------------

  private joinSelect = `SELECT r.*, c.name AS client_name, mt.name AS meeting_type_name
     FROM recordings r
     LEFT JOIN clients       c  ON c.id  = r.client_id
     LEFT JOIN meeting_types mt ON mt.id = r.meeting_type_id`;

  getRecordingJoined(id: string): JoinedRecordingRow | undefined {
    return this.db.prepare(`${this.joinSelect} WHERE r.id = ?`).get(id) as
      | JoinedRecordingRow
      | undefined;
  }

  /**
   * Everything the inbox window shows: inbox / in-flight / error / cancelled
   * / complete. Skipped rows are excluded — they're gone from the user's
   * perspective.
   */
  listActiveJoined(): JoinedRecordingRow[] {
    return this.db
      .prepare(
        `${this.joinSelect}
         WHERE r.status NOT IN ('skipped')
         ORDER BY
           CASE r.status
             WHEN 'error'       THEN 1
             WHEN 'tagged'      THEN 2
             WHEN 'downloading' THEN 2
             WHEN 'transcribing'THEN 2
             WHEN 'summarising' THEN 2
             WHEN 'writing'     THEN 2
             WHEN 'inbox'       THEN 3
             WHEN 'cancelled'   THEN 4
             WHEN 'complete'    THEN 5
             ELSE 6
           END,
           r.updated_at DESC`,
      )
      .all() as JoinedRecordingRow[];
  }

  /**
   * Tag an inbox recording: attach client + meeting type and transition to
   * `tagged`. The pipeline (M2) picks up `tagged` rows and processes them.
   * Returns true iff the recording was actually transitioned (prevents
   * double-tagging via rapid clicks).
   */
  tagRecording(id: string, clientId: string, meetingTypeId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET client_id = ?, meeting_type_id = ?, status = 'tagged', updated_at = ?
         WHERE id = ? AND status = 'inbox'`,
      )
      .run(clientId, meetingTypeId, Date.now(), id);
    return result.changes > 0;
  }

  inboxCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM recordings WHERE status = 'inbox'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Ids of every errored recording, newest failure first. */
  listErroredIds(): string[] {
    return (
      this.db
        .prepare("SELECT id FROM recordings WHERE status = 'error' ORDER BY updated_at DESC")
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  /**
   * Mark every errored recording as skipped, clearing the tray warning.
   * Returns how many rows changed. Deliberately does not touch audio or
   * written outputs — a dismissed row can be re-tagged from Plaud later.
   */
  dismissAllErrors(): number {
    return this.db
      .prepare("UPDATE recordings SET status = 'skipped', updated_at = ? WHERE status = 'error'")
      .run(Date.now()).changes;
  }

  errorCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM recordings WHERE status = 'error'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Count of recordings currently in pipeline-running states plus tagged
   * (queued). Returned as {@link ProcessingSummary}. Used by the tray to
   * show a live processing line. Cheap - one small aggregate query.
   */
  processingSummary(): ProcessingSummary {
    const row = this.db
      .prepare(
        `SELECT
           (SELECT status FROM recordings
              WHERE status IN ('downloading','transcribing','summarising','writing')
              ORDER BY updated_at DESC LIMIT 1) AS current,
           (SELECT COUNT(*) FROM recordings
              WHERE status IN ('downloading','transcribing','summarising','writing')) AS running,
           (SELECT COUNT(*) FROM recordings WHERE status = 'tagged') AS queued`,
      )
      .get() as { current: RecordingStatus | null; running: number; queued: number } | undefined;
    return {
      currentStatus: row?.current ?? null,
      running: row?.running ?? 0,
      queued: row?.queued ?? 0,
    };
  }

  /**
   * Mark as skipped any recording that has been in status='complete' for
   * longer than the given threshold. Returns the number of rows swept.
   * Called opportunistically by the inbox list handler so the UI
   * self-cleans on every refresh without needing a separate scheduler.
   *
   * `minutes <= 0` disables the sweep and returns 0 without touching the DB.
   */
  sweepCompletedOlderThan(minutes: number): number {
    if (minutes <= 0) return 0;
    const cutoff = Date.now() - minutes * 60_000;
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET status = 'skipped', updated_at = ?
         WHERE status = 'complete' AND updated_at < ?`,
      )
      .run(Date.now(), cutoff);
    return result.changes;
  }

  // --- app state -----------------------------------------------------------

  /**
   * Read a single app_state value. Returns undefined if the key is not set.
   * Used for install-level flags (e.g. hasCompletedInitialPoll) that don't
   * belong in config.json because they're never user-edited.
   */
  getAppState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setAppState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }
}
