import { defaultMeetingTypeIds } from '../shared/meetingTypeLine.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { stateDbFile } from './paths.js';
import type { OutputsConfig } from './config.js';
import type { Attendee } from '../shared/attendees.js';
import type { CalendarCoverage, CalendarMeeting } from '../shared/calendar.js';

export type RecordingStatus =
  | 'inbox'
  | 'tagged'
  | 'downloading'
  | 'transcribing'
  | 'summarising'
  | 'writing'
  /** Summarised, held before writing until the user confirms where it's filed; see shared/filing.ts. */
  | 'to_file'
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
  /**
   * Per-recording output-destination overrides. NULL means "inherit
   * whatever Settings -> Outputs currently says"; 0/1 is an explicit
   * override set from a checkbox on the Inbox row, independent of the
   * global config. See effectiveOutputTargets.
   */
  output_markdown: number | null;
  output_html: number | null;
  output_apple_note: number | null;
  /**
   * JSON-encoded Attendee[] pasted into the tag sheet, or NULL if none
   * were given. See src/shared/attendees.ts for the shape and parsing,
   * and doTranscribe/doSummarise in pipelineSteps.ts for how it's used.
   */
  attendees_json: string | null;
  /** Prioritises the next claim and bypasses an idle/overnight processing schedule. */
  urgent: number;
  /** Queued by "Queue all": classify before summarising, hold at 'to_file' before writing. Migration 16. */
  needs_filing: number;
  /** The classifier's client pick; null when nothing clearly fitted. The pick for meeting type is meeting_type_id itself. */
  suggested_client_id: string | null;
  filing_confidence: string | null;
  filing_reason: string | null;
  /** JSON CalendarMatch: the imported calendar meeting this recording overlapped. Migration 17. */
  calendar_match_json: string | null;
  /** Filed automatically at high confidence (migration 20). */
  auto_filed: number;
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
  /** Account context added to every summary for this client (shared/summaryInput.ts). Migration 18. */
  context: string | null;
  meeting_type_ids_json: string | null;
}

export interface MeetingTypeRow {
  id: string;
  name: string;
  prompt: string;
  is_builtin: number;
  sort_order: number;
  original_prompt_hash: string | null;
  /** When to use this type, for the classifiers and the user. Migration 19. */
  description: string | null;
  /** Kept for past recordings but no longer offered or auto-chosen. */
  retired: number;
  created_at: number;
  updated_at: number;
}

export interface RegisterItemRow {
  id: string;
  client_id: string;
  kind: 'action' | 'decision';
  text: string;
  owner: string | null;
  due_at: number | null;
  status: 'open' | 'done' | null;
  source_recording_id: string;
  created_at: number;
  completed_at: number | null;
}

export interface JoinedRegisterItemRow extends RegisterItemRow {
  client_name: string;
  source_title: string;
  source_date: number;
}

export interface SummaryVersionRow {
  id: string;
  recording_id: string;
  summary_text: string;
  model: string;
  prompt_snapshot: string;
  meeting_type_name: string;
  is_active: number;
  created_at: number;
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

/**
 * The steps this recording has to go through, in order.
 *
 * Not every recording needs all four: a Plaud recording is downloaded
 * then transcribed, a dragged-in audio file skips the download, and an
 * imported transcript skips straight to summarising. The inbox uses
 * this to show honest progress ("1/2 Summarising…" rather than
 * "3/4"), so the count has to reflect the actual work.
 */
export function stepPlanFor(row: RecordingRow): PipelineStep[] {
  const transcriptOnly =
    row.source === 'local' && row.audio_path === null && row.transcript_text !== null;
  const plan: PipelineStep[] = [];
  if (!transcriptOnly) {
    if (row.source === 'plaud') plan.push('download');
    plan.push('transcribe');
  }
  plan.push('summarise', 'write');
  return plan;
}

export function nextNeededStep(row: RecordingRow): PipelineStep {
  // Transcript first: a row that already has text needs no audio at all.
  // Imported transcripts (from a previous Markdown output or a .txt) have
  // transcript_text set and audio_path null, and must start at summarise
  // rather than trying to download audio that doesn't exist.
  if (!row.transcript_text) {
    if (!row.audio_path) return 'download';
    return 'transcribe';
  }
  if (!row.summary_text) return 'summarise';
  return 'write';
}

/**
 * Merge a recording's per-row output-destination overrides with the
 * global Settings -> Outputs config: an explicit 0/1 on the row wins,
 * NULL falls back to whatever the global flag currently says. Used both
 * to render the Inbox row's checkboxes and to decide, in doWriteOutputs,
 * which destinations actually get attempted.
 */
export function effectiveOutputTargets(
  row: Pick<RecordingRow, 'output_markdown' | 'output_html' | 'output_apple_note'>,
  outputs: OutputsConfig,
): { markdown: boolean; html: boolean; appleNote: boolean } {
  return {
    markdown: row.output_markdown === null ? outputs.markdown.enabled : row.output_markdown === 1,
    html: row.output_html === null ? outputs.html.enabled : row.output_html === 1,
    appleNote: row.output_apple_note === null ? outputs.appleNotes.enabled : row.output_apple_note === 1,
  };
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
  {
    version: 11,
    sql: `
      -- Per-recording output-destination overrides, editable from a
      -- checkbox on the Inbox row. NULL (the migrated default for every
      -- existing row) means "inherit Settings -> Outputs' current
      -- setting"; an explicit 0/1 wins over the global config for that
      -- one recording only. See effectiveOutputTargets in this file and
      -- doWriteOutputs in pipelineSteps.ts.
      ALTER TABLE recordings ADD COLUMN output_markdown   INTEGER;
      ALTER TABLE recordings ADD COLUMN output_html       INTEGER;
      ALTER TABLE recordings ADD COLUMN output_apple_note INTEGER;
    `,
  },
  {
    version: 12,
    sql: `
      -- Attendees pasted into the tag sheet (raw Outlook invite text,
      -- parsed client-side into name/email/company), stored as JSON.
      -- NULL for every existing row and any recording tagged without
      -- pasting anything -- the pipeline treats that exactly like today
      -- (no extra Whisper hints, no roster in the summarise prompt).
      -- See src/shared/attendees.ts.
      ALTER TABLE recordings ADD COLUMN attendees_json TEXT;
    `,
  },
  {
    version: 13,
    sql: `
      -- Confirmed action/decision register (see shared/register.ts). Every
      -- row is added by an explicit user action -- from a client brief
      -- point or the meeting reader -- never inferred automatically.
      --
      -- status is meaningful only for actions: an action starts 'open'
      -- and the user marks it 'done' themselves; absence from a later
      -- meeting is never treated as completion. Decisions are a
      -- historical record, not something to complete, so their status
      -- is NULL rather than a permanently-'done' action.
      --
      -- source_recording_id is a hard reference: recordings are never
      -- deleted by this app (only skipped/hidden), so "linked to its
      -- source meeting" can stay a real foreign key rather than a
      -- best-effort label.
      CREATE TABLE register_items (
        id                  TEXT PRIMARY KEY,
        client_id           TEXT NOT NULL REFERENCES clients(id),
        kind                TEXT NOT NULL CHECK (kind IN ('action','decision')),
        text                TEXT NOT NULL,
        owner               TEXT,
        due_at              INTEGER,
        status              TEXT CHECK (
                               (kind = 'action'   AND status IN ('open','done')) OR
                               (kind = 'decision' AND status IS NULL)
                             ),
        source_recording_id TEXT NOT NULL REFERENCES recordings(id),
        created_at          INTEGER NOT NULL,
        completed_at        INTEGER
      );
      CREATE INDEX idx_register_items_client ON register_items(client_id, kind);
    `,
  },
  {
    version: 14,
    sql: `
      -- Summary version history (see main/summaryVersions.ts). Every
      -- summary doSummarise produces is logged here, active by
      -- construction (it just became the live summary); a version
      -- generated on demand from the reader to try a different model or
      -- meeting-type prompt is logged inactive until the user explicitly
      -- keeps it (State.activateSummaryVersion). Existing rows are not
      -- backfilled -- their pre-existing summary_text/model_snapshot on
      -- \`recordings\` stands in as an implicit "current" version at read
      -- time instead (see buildVersionList), consistent with this
      -- project's preference for read-time reconciliation over
      -- backfill migrations (see the original_prompt_hash precedent).
      CREATE TABLE summary_versions (
        id                TEXT PRIMARY KEY,
        recording_id      TEXT NOT NULL REFERENCES recordings(id),
        summary_text      TEXT NOT NULL,
        model             TEXT NOT NULL,
        prompt_snapshot   TEXT NOT NULL,
        meeting_type_name TEXT NOT NULL,
        is_active         INTEGER NOT NULL DEFAULT 0,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_summary_versions_recording ON summary_versions(recording_id, created_at DESC);
    `,
  },
  {
    version: 15,
    sql: `
      -- Lets one tagged recording jump an idle/overnight processing
      -- schedule (see main/processingSchedule.ts and Worker.loop in
      -- worker.ts). Meaningless in the default 'immediate' schedule mode,
      -- where every tagged row is already claimable regardless. 0 for
      -- every existing row -- nothing was ever "urgent" before this
      -- existed, and an explicit user action is what sets it from here.
      ALTER TABLE recordings ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 16,
    sql: `
      -- "Queue all, file later" (see main/filingSuggestion.ts). A row
      -- queued this way has no client or meeting type; the pipeline
      -- classifies it after transcription and holds it at 'to_file'
      -- before writing. suggested_client_id is deliberately not a foreign
      -- key: it is advisory, and a client deleted in the meantime just
      -- means the Inbox shows no pre-selection.
      ALTER TABLE recordings ADD COLUMN needs_filing INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE recordings ADD COLUMN suggested_client_id TEXT;
      ALTER TABLE recordings ADD COLUMN filing_confidence TEXT;
      ALTER TABLE recordings ADD COLUMN filing_reason TEXT;
    `,
  },
  {
    version: 17,
    sql: `
      -- Meetings read from Outlook calendar printouts (main/calendar/).
      -- Re-importing a month replaces that period's meetings, so moved or
      -- cancelled invites don't linger. The whole meeting is kept as JSON;
      -- start/end are columns so matching can fetch just a recording's
      -- neighbourhood.
      CREATE TABLE calendar_meetings (
        id           TEXT PRIMARY KEY,
        start_ms     INTEGER NOT NULL,
        end_ms       INTEGER NOT NULL,
        meeting_json TEXT NOT NULL,
        imported_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_calendar_meetings_start ON calendar_meetings(start_ms);
      ALTER TABLE recordings ADD COLUMN calendar_match_json TEXT;
    `,
  },
  {
    version: 18,
    sql: `
      -- Per-client account context: programmes, glossary, stakeholders
      -- and priorities, written by the user and added to the summary
      -- request for that client's meetings (shared/summaryInput.ts).
      -- Prompts stay per meeting type; this is what differs per client.
      ALTER TABLE clients ADD COLUMN context TEXT;
    `,
  },
  {
    version: 19,
    sql: `
      -- "When to use" per meeting type, read by both classifiers instead of
      -- the prompt's opening (which for older prompts was boilerplate like
      -- "You are an expert…"); and a retired flag, so overlapping older
      -- types stop being offered or auto-chosen while past summaries keep
      -- their type. Both are user-edited in Settings → Prompts.
      ALTER TABLE meeting_types ADD COLUMN description TEXT;
      ALTER TABLE meeting_types ADD COLUMN retired INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 20,
    sql: `
      -- 1 when a "Queue all" recording was filed without waiting in Ready
      -- to file, because the classifier was highly confident and the
      -- calendar agreed (opt-in: config autoFileHighConfidence). Shown on
      -- the row so an automatic filing is never mistaken for the user's.
      ALTER TABLE recordings ADD COLUMN auto_filed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 21,
    sql: `
      ALTER TABLE clients ADD COLUMN meeting_type_ids_json TEXT;
      -- The requested LADFFA restriction, including already-created equivalents.
      UPDATE clients SET meeting_type_ids_json = (
        SELECT json_group_array(id) FROM (
          SELECT 'club-agm' AS id UNION SELECT 'club-committee'
          UNION SELECT id FROM meeting_types WHERE lower(trim(name)) IN
            ('agm', 'committee meeting', 'club · agm', 'club · committee meeting')
        )
      ) WHERE lower(trim(name)) = 'ladffa';
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

  upsertClient(row: Omit<ClientRow, 'created_at' | 'context' | 'meeting_type_ids_json'>): void {
    const now = Date.now();
    const ids = defaultMeetingTypeIds(row.name);
    this.db
      .prepare(
        `INSERT INTO clients (id, name, is_builtin, sort_order, created_at, meeting_type_ids_json)
         VALUES (@id, @name, @is_builtin, @sort_order, @created_at, @meeting_type_ids_json)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order`,
      )
      .run({ ...row, created_at: now, meeting_type_ids_json: ids === null ? null : JSON.stringify(ids) });
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

  upsertMeetingType(row: Omit<MeetingTypeRow, 'created_at' | 'updated_at' | 'description' | 'retired'>): void {
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

  // output_markdown/output_html/output_apple_note/attendees_json
  // deliberately excluded — every newly-inserted recording starts at
  // NULL (no per-row output override, no attendees), which is also
  // SQLite's default for a column not named in the INSERT below, so
  // callers never need to pass them.
  insertRecording(
    r: Omit<
      RecordingRow,
      | 'retries'
      | 'created_at'
      | 'updated_at'
      | 'output_markdown'
      | 'output_html'
      | 'output_apple_note'
      | 'attendees_json'
      | 'needs_filing'
      | 'suggested_client_id'
      | 'filing_confidence'
      | 'filing_reason'
      | 'calendar_match_json'
      | 'auto_filed'
    >,
  ): void {
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
         WHERE id = ? AND status IN ('inbox', 'error', 'cancelled', 'complete', 'to_file')`,
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
   * Urgent recordings are claimed first, oldest sync first within each
   * priority. The current recording is allowed to finish before claiming
   * another; setting urgency never interrupts its in-flight work.
   *
   * Returns the row as it looked before the status change, or undefined
   * if nothing is ready (or nothing's next-step is allowed).
   *
   * `urgentOnly`: when an idle/overnight processing schedule is blocking
   * normal claims (see evaluateSchedule in processingSchedule.ts), the
   * worker still wants urgent-flagged rows to jump straight through —
   * this restricts the claim to `urgent = 1` rows without otherwise
   * changing the pause/step-allowed logic above. A row whose next step
   * is 'write' is claimable even then: writing is quick, never pausable,
   * and only ever queued by something the user just did (filing a
   * recording, turning on an output) — not worth waiting overnight for.
   */
  claimNextTagged(allowedSteps?: Set<PipelineStep>, urgentOnly = false): RecordingRow | undefined {
    return this.db.transaction((): RecordingRow | undefined => {
      const rows = this.db
        .prepare(
          `SELECT * FROM recordings
           WHERE status = 'tagged'
           ORDER BY urgent DESC, synced_at ASC, id ASC`,
        )
        .all() as RecordingRow[];
      for (const row of rows) {
        const nextStep = nextNeededStep(row);
        if (allowedSteps && !allowedSteps.has(nextStep)) continue;
        if (urgentOnly && row.urgent !== 1 && nextStep !== 'write') continue;
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

  /**
   * Reset a finished recording back to the start of the pipeline: clears
   * the transcript, summary, and all output tracking, and returns it to
   * `tagged` so the worker re-transcribes and re-summarises from scratch.
   * Unlike retry(), which resumes wherever a failed run stopped, this
   * always restarts from the audio.
   *
   * Only legal from `complete`/`skipped` — a fully-finished recording.
   * `error`/`cancelled` rows already have retry() for resuming; this isn't
   * a substitute for that.
   *
   * The caller owns the destructive housekeeping this implies outside the
   * DB — deleting the old Markdown/HTML files and Apple Note — before
   * calling this, since the row is eligible for the worker to claim the
   * moment it flips to `tagged`.
   *
   * @param clearAudioPath - true to null out audio_path too, forcing the
   *   pipeline through `download` again. Used when the local file is gone
   *   but the recording has a cloud copy to re-fetch (see audioFileExists
   *   in pipelineSteps.ts) — audio retention never touches Plaud-sourced
   *   rows, so this is the 'plaud' fallback path, not the common case.
   */
  fullRerun(id: string, clearAudioPath: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET status = 'tagged',
             transcript_text = NULL, summary_text = NULL,
             markdown_path = NULL, html_path = NULL, apple_note_id = NULL,
             markdown_written_at = NULL, html_written_at = NULL, apple_note_written_at = NULL,
             error = NULL, is_auth_error = 0, last_step = NULL,
             truncation_warning = 0, estimated_input_tokens = NULL, context_window_at_submit = NULL,
             processed_externally = 0,
             audio_path = CASE WHEN ? THEN NULL ELSE audio_path END,
             updated_at = ?
         WHERE id = ? AND status IN ('complete', 'skipped')`,
      )
      .run(clearAudioPath ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  /**
   * Apply a corrected transcript to a finished recording and queue it for
   * re-summarisation only — unlike fullRerun, transcript_text and
   * audio_path are left alone (transcript_text is set to the corrected
   * text, not cleared), so the worker's nextNeededStep resumes straight
   * at 'summarise' and Whisper never re-runs. See ipc.ts's
   * Channels.MeetingCorrect for the caller, which owns deleting the
   * stale Markdown/HTML/Apple Note first (same contract as fullRerun).
   *
   * Only legal from 'complete'/'skipped' with an existing stored
   * transcript — there is nothing to correct on a row that never had
   * one (e.g. a Markdown-fallback-only transcript, which lives on disk,
   * not in this column).
   */
  correctTranscript(id: string, correctedText: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET status = 'tagged',
             transcript_text = @correctedText,
             summary_text = NULL,
             markdown_path = NULL, html_path = NULL, apple_note_id = NULL,
             markdown_written_at = NULL, html_written_at = NULL, apple_note_written_at = NULL,
             error = NULL, is_auth_error = 0, last_step = NULL,
             truncation_warning = 0, estimated_input_tokens = NULL, context_window_at_submit = NULL,
             processed_externally = 0,
             updated_at = @updated_at
         WHERE id = @id AND status IN ('complete','skipped')
           AND transcript_text IS NOT NULL AND trim(transcript_text) != ''`,
      )
      .run({ id, correctedText, updated_at: Date.now() });
    return result.changes > 0;
  }

  /**
   * Set a recording's per-destination output overrides. Always writes an
   * explicit 0/1 for all three columns — the Inbox checkboxes are never in
   * a "some inherited, some overridden" state once the user has touched
   * one of them for a row. Legal from any status: it only ever changes
   * what a future write step will attempt (see effectiveOutputTargets),
   * never anything mid-flight.
   */
  setOutputTargets(
    id: string,
    targets: { markdown: boolean; html: boolean; appleNote: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE recordings
         SET output_markdown = ?, output_html = ?, output_apple_note = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(targets.markdown ? 1 : 0, targets.html ? 1 : 0, targets.appleNote ? 1 : 0, Date.now(), id);
  }

  // --- joined reads ------------------------------------------------------

  private joinSelect = `SELECT r.*, c.name AS client_name, mt.name AS meeting_type_name
     FROM recordings r
     LEFT JOIN clients       c  ON c.id  = r.client_id
     LEFT JOIN meeting_types mt ON mt.id = r.meeting_type_id`;

  listSearchableJoined(): JoinedRecordingRow[] {
    return this.db.prepare(`${this.joinSelect}
      WHERE r.summary_text IS NOT NULL OR r.transcript_text IS NOT NULL OR r.markdown_path IS NOT NULL
      ORDER BY COALESCE(r.start_time, r.synced_at) DESC`).all() as JoinedRecordingRow[];
  }

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
             WHEN 'to_file'     THEN 2
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
  tagRecording(
    id: string,
    clientId: string,
    meetingTypeId: string,
    attendees?: Attendee[],
    urgent?: boolean,
  ): boolean {
    const attendeesJson = attendees && attendees.length > 0 ? JSON.stringify(attendees) : null;
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET client_id = ?, meeting_type_id = ?, attendees_json = ?, urgent = ?, needs_filing = 0,
             status = 'tagged', updated_at = ?
         WHERE id = ? AND status = 'inbox'`,
      )
      .run(clientId, meetingTypeId, attendeesJson, urgent ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  /**
   * "Queue all": every untagged inbox recording goes to the pipeline with
   * no client or meeting type, to be classified after transcription and
   * held at 'to_file' before anything is written. Follows the processing
   * schedule like any tagged row. Returns how many were queued.
   */
  queueAllForFiling(minDurationSeconds = 0): { queued: number; hidden: number } {
    return this.db.transaction(() => {
      const now = Date.now();
      // Shorter than the configured minimum: hidden rather than processed
      // (recoverable from Hidden). Unknown length is never "too short".
      const hidden =
        minDurationSeconds > 0
          ? this.db
              .prepare(
                `UPDATE recordings SET status = 'skipped', updated_at = ?
                 WHERE status = 'inbox' AND duration_seconds IS NOT NULL AND duration_seconds < ?`,
              )
              .run(now, minDurationSeconds).changes
          : 0;
      const queued = this.db
        .prepare(
          `UPDATE recordings
           SET status = 'tagged', needs_filing = 1, client_id = NULL, meeting_type_id = NULL,
               urgent = 0, updated_at = ?
           WHERE status = 'inbox'`,
        )
        .run(now).changes;
      return { queued, hidden };
    })();
  }

  /**
   * Confirm where a held recording goes and queue it to be written. When
   * the chosen meeting type differs from the one it was summarised with,
   * the summary is cleared so the worker regenerates it from the stored
   * transcript first (see filingNeedsResummary). Only legal from
   * 'to_file'.
   */
  fileRecording(id: string, clientId: string, meetingTypeId: string, resummarise: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE recordings
         SET client_id = @clientId, meeting_type_id = @meetingTypeId, needs_filing = 0,
             summary_text = CASE WHEN @resummarise THEN NULL ELSE summary_text END,
             status = 'tagged', updated_at = @updated_at
         WHERE id = @id AND status = 'to_file'`,
      )
      .run({ id, clientId, meetingTypeId, resummarise: resummarise ? 1 : 0, updated_at: Date.now() });
    return result.changes > 0;
  }

  /**
   * Toggle urgency on an already-tagged (queued or actively running)
   * recording — the inbox-side counterpart to tagRecording's initial
   * `urgent` flag, for "oh wait, I need this one now" after the fact.
   * Legal from any status: flipping it on a row that's already running
   * or complete is harmless, just moot.
   */
  setUrgent(id: string, urgent: boolean): boolean {
    const result = this.db
      .prepare('UPDATE recordings SET urgent = ?, updated_at = ? WHERE id = ?')
      .run(urgent ? 1 : 0, Date.now(), id);
    return result.changes > 0;
  }

  /**
   * Attendee lists from past tagged recordings, newest first — the
   * history the tag sheet learns suggestions from. Pass a clientId to
   * restrict to that client's meetings.
   */
  listTaggedAttendees(
    clientId?: string,
    limit = 200,
  ): { client_id: string; attendees_json: string }[] {
    const where = clientId ? 'AND client_id = ?' : '';
    const params: unknown[] = clientId ? [clientId, limit] : [limit];
    return this.db
      .prepare(
        `SELECT client_id, attendees_json FROM recordings
         WHERE attendees_json IS NOT NULL AND client_id IS NOT NULL ${where}
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params) as { client_id: string; attendees_json: string }[];
  }

  /** Recordings waiting on the user: untagged, or processed and waiting to be filed. */
  inboxCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM recordings WHERE status IN ('inbox', 'to_file')")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Hidden (skipped) recordings, newest first. Includes the back
   * catalogue the first poll skipped, so it is limited by default —
   * a thousand rows is a list nobody reads.
   */
  listHiddenJoined(limit = 50): JoinedRecordingRow[] {
    return this.db
      .prepare(`${this.joinSelect} WHERE r.status = 'skipped' ORDER BY r.updated_at DESC LIMIT ?`)
      .all(limit) as JoinedRecordingRow[];
  }

  hiddenCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM recordings WHERE status = 'skipped'")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Every recording ever seen, regardless of status — the History window's
   * unbounded answer to "find that meeting from weeks ago," as opposed to
   * listActiveJoined()/listHiddenJoined() which both exist to serve the
   * Inbox's "what needs my attention" purpose and filter accordingly.
   * `search` matches against filename, client name, or meeting type name;
   * pass '' for no filter.
   */
  listAllJoined(search: string, limit = 50, offset = 0): JoinedRecordingRow[] {
    const like = `%${search}%`;
    return this.db
      .prepare(
        `${this.joinSelect}
         WHERE r.filename LIKE ? OR c.name LIKE ? OR mt.name LIKE ?
         ORDER BY r.synced_at DESC LIMIT ? OFFSET ?`,
      )
      .all(like, like, like, limit, offset) as JoinedRecordingRow[];
  }

  listAllCount(search: string): number {
    const like = `%${search}%`;
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as n
         FROM recordings r
         LEFT JOIN clients       c  ON c.id  = r.client_id
         LEFT JOIN meeting_types mt ON mt.id = r.meeting_type_id
         WHERE r.filename LIKE ? OR c.name LIKE ? OR mt.name LIKE ?`,
      )
      .get(like, like, like) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * Bring a hidden recording back. A row that already produced output
   * returns to `complete` so its files stay reachable; anything else
   * goes back to `inbox` to be processed. Returns the new status, or
   * undefined if the row wasn't hidden.
   */
  unhideRecording(id: string): RecordingStatus | undefined {
    return this.db.transaction((): RecordingStatus | undefined => {
      const row = this.db
        .prepare("SELECT * FROM recordings WHERE id = ? AND status = 'skipped'")
        .get(id) as RecordingRow | undefined;
      if (!row) return undefined;
      const hasOutput =
        row.markdown_written_at !== null ||
        row.html_written_at !== null ||
        row.apple_note_written_at !== null;
      const next: RecordingStatus = hasOutput ? 'complete' : 'inbox';
      this.db
        .prepare('UPDATE recordings SET status = ?, updated_at = ? WHERE id = ?')
        .run(next, Date.now(), id);
      return next;
    })();
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

  // --- register items --------------------------------------------------------

  private registerJoinSelect = `SELECT ri.*, c.name AS client_name,
           r.filename AS source_title, COALESCE(r.start_time, r.synced_at) AS source_date
     FROM register_items ri
     JOIN clients    c ON c.id = ri.client_id
     JOIN recordings r ON r.id = ri.source_recording_id`;

  /**
   * Add a confirmed register item. Callers (IPC) validate with
   * checkRegisterAdd first; this only enforces what the DB schema
   * already would (status null for a decision, set for an action).
   */
  addRegisterItem(row: {
    id: string;
    client_id: string;
    kind: 'action' | 'decision';
    text: string;
    owner: string | null;
    due_at: number | null;
    source_recording_id: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO register_items (
           id, client_id, kind, text, owner, due_at, status, source_recording_id, created_at
         ) VALUES (
           @id, @client_id, @kind, @text, @owner, @due_at, @status, @source_recording_id, @created_at
         )`,
      )
      .run({ ...row, status: row.kind === 'action' ? 'open' : null, created_at: Date.now() });
  }

  /** Newest first. `clientId` narrows to one client; omit to list every client. */
  listRegisterItemsJoined(clientId?: string): JoinedRegisterItemRow[] {
    const where = clientId ? 'WHERE ri.client_id = ?' : '';
    return this.db
      .prepare(`${this.registerJoinSelect} ${where} ORDER BY ri.created_at DESC`)
      .all(...(clientId ? [clientId] : [])) as JoinedRegisterItemRow[];
  }

  /**
   * Set an action's open/done state. Refuses decisions (no status to
   * set) so the only way status ever changes is the user's own click.
   * Returns false if the id doesn't exist or names a decision.
   */
  setRegisterItemStatus(id: string, status: 'open' | 'done'): boolean {
    const result = this.db
      .prepare(
        `UPDATE register_items
         SET status = @status, completed_at = @completed_at
         WHERE id = @id AND kind = 'action'`,
      )
      .run({ id, status, completed_at: status === 'done' ? Date.now() : null });
    return result.changes > 0;
  }

  deleteRegisterItem(id: string): boolean {
    return this.db.prepare('DELETE FROM register_items WHERE id = ?').run(id).changes > 0;
  }

  // --- summary versions ------------------------------------------------------

  /**
   * Log a summary version. `active` only ever touches this table's own
   * `is_active` bookkeeping (deactivating any prior active version for
   * the recording) — it never writes to `recordings` itself. The normal
   * pipeline (doSummarise) calls this with `active: true` right after it
   * writes the new summary onto the recording row directly; the on-demand
   * "generate an alternative" action calls it with `active: false`,
   * logging a candidate without disturbing the live summary.
   */
  addSummaryVersion(row: {
    id: string;
    recording_id: string;
    summary_text: string;
    model: string;
    prompt_snapshot: string;
    meeting_type_name: string;
    active: boolean;
  }): void {
    this.db.transaction(() => {
      if (row.active) {
        this.db
          .prepare('UPDATE summary_versions SET is_active = 0 WHERE recording_id = ?')
          .run(row.recording_id);
      }
      this.db
        .prepare(
          `INSERT INTO summary_versions (
             id, recording_id, summary_text, model, prompt_snapshot, meeting_type_name, is_active, created_at
           ) VALUES (
             @id, @recording_id, @summary_text, @model, @prompt_snapshot, @meeting_type_name, @is_active, @created_at
           )`,
        )
        .run({ ...row, is_active: row.active ? 1 : 0, created_at: Date.now() });
    })();
  }

  /** Newest first. */
  listSummaryVersions(recordingId: string): SummaryVersionRow[] {
    return this.db
      .prepare('SELECT * FROM summary_versions WHERE recording_id = ? ORDER BY created_at DESC')
      .all(recordingId) as SummaryVersionRow[];
  }

  /**
   * Promote a logged version back into being the live summary: copies its
   * text/model/prompt onto the recording row, clears output tracking so
   * the worker re-writes (not re-summarises or re-transcribes — see
   * nextNeededStep), and flips the version bookkeeping. Only legal from
   * 'complete'/'skipped', matching correctTranscript's gating. Returns
   * the recording id on success so the caller can nudge the worker and
   * log, or null if the version doesn't exist or the recording isn't in
   * a promotable state.
   */
  activateSummaryVersion(versionId: string): string | null {
    const version = this.db
      .prepare('SELECT * FROM summary_versions WHERE id = ?')
      .get(versionId) as SummaryVersionRow | undefined;
    if (!version) return null;
    return this.db.transaction((): string | null => {
      const result = this.db
        .prepare(
          `UPDATE recordings
           SET summary_text = @summary_text, model_snapshot = @model, prompt_snapshot = @prompt_snapshot,
               markdown_path = NULL, html_path = NULL, apple_note_id = NULL,
               markdown_written_at = NULL, html_written_at = NULL, apple_note_written_at = NULL,
               status = 'tagged', error = NULL, is_auth_error = 0, last_step = NULL,
               truncation_warning = 0, estimated_input_tokens = NULL, context_window_at_submit = NULL,
               processed_externally = 0, updated_at = @updated_at
           WHERE id = @recording_id AND status IN ('complete','skipped')`,
        )
        .run({
          summary_text: version.summary_text,
          model: version.model,
          prompt_snapshot: version.prompt_snapshot,
          recording_id: version.recording_id,
          updated_at: Date.now(),
        });
      if (result.changes === 0) return null;
      this.db
        .prepare('UPDATE summary_versions SET is_active = 0 WHERE recording_id = ?')
        .run(version.recording_id);
      this.db.prepare('UPDATE summary_versions SET is_active = 1 WHERE id = ?').run(versionId);
      return version.recording_id;
    })();
  }

  // --- calendar ------------------------------------------------------------

  /** Replace every stored meeting starting within the imported period with the imported ones. */
  replaceCalendarMeetings(meetings: CalendarMeeting[]): void {
    if (meetings.length === 0) return;
    const from = Math.min(...meetings.map((m) => m.startMs));
    const to = Math.max(...meetings.map((m) => m.startMs));
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO calendar_meetings (id, start_ms, end_ms, meeting_json, imported_at) VALUES (?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM calendar_meetings WHERE start_ms BETWEEN ? AND ?').run(from, to);
      for (const m of meetings) ins.run(m.id, m.startMs, m.endMs, JSON.stringify(m), now);
    })();
  }

  listCalendarMeetingsBetween(fromMs: number, toMs: number): CalendarMeeting[] {
    return (
      this.db
        .prepare('SELECT meeting_json FROM calendar_meetings WHERE start_ms < ? AND end_ms > ? ORDER BY start_ms')
        .all(toMs, fromMs) as { meeting_json: string }[]
    ).map((r) => JSON.parse(r.meeting_json) as CalendarMeeting);
  }

  calendarCoverage(): CalendarCoverage {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS meetings, MIN(start_ms) AS firstMs, MAX(start_ms) AS lastMs, MAX(imported_at) AS importedAt
         FROM calendar_meetings`,
      )
      .get() as CalendarCoverage;
  }

  /** Recordings that started in [fromMs, toMs] and aren't mid-pipeline. */
  listRecordingsStartedBetween(fromMs: number, toMs: number): RecordingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM recordings
         WHERE start_time BETWEEN ? AND ?
           AND status NOT IN ('downloading','transcribing','summarising','writing')`,
      )
      .all(fromMs, toMs) as RecordingRow[];
  }

  /** "Queue all" rows that haven't been transcribed yet. */
  listQueuedForFilingUnstarted(): RecordingRow[] {
    return this.db
      .prepare(`SELECT * FROM recordings WHERE needs_filing = 1 AND status = 'tagged' AND transcript_text IS NULL`)
      .all() as RecordingRow[];
  }

  setClientMeetingTypes(id: string, ids: string[] | null): boolean {
    return this.db.prepare('UPDATE clients SET meeting_type_ids_json = ? WHERE id = ?')
      .run(ids === null ? null : JSON.stringify(ids), id).changes > 0;
  }

  setClientContext(id: string, context: string | null): boolean {
    const text = context?.trim() ? context.trim() : null;
    return this.db.prepare('UPDATE clients SET context = ? WHERE id = ?').run(text, id).changes > 0;
  }

  /** Edit a meeting type's description and/or retired flag. Returns true iff a row changed. */
  updateMeetingTypeMeta(id: string, patch: { description?: string | null; retired?: boolean }): boolean {
    const fields: string[] = [];
    const params: Record<string, unknown> = { id, updated_at: Date.now() };
    if (patch.description !== undefined) {
      fields.push('description = @description');
      params.description = patch.description?.trim() ? patch.description.trim() : null;
    }
    if (patch.retired !== undefined) {
      fields.push('retired = @retired');
      params.retired = patch.retired ? 1 : 0;
    }
    if (fields.length === 0) return false;
    fields.push('updated_at = @updated_at');
    return this.db.prepare(`UPDATE meeting_types SET ${fields.join(', ')} WHERE id = @id`).run(params).changes > 0;
  }

  /** File a held "Queue all" recording under its suggested client, marked as automatic. */
  autoFileRecording(id: string, clientId: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE recordings SET client_id = ?, needs_filing = 0, auto_filed = 1, updated_at = ?
           WHERE id = ? AND needs_filing = 1`,
        )
        .run(clientId, Date.now(), id).changes > 0
    );
  }

  /**
   * Send a finished recording back to Ready to file, with its current
   * client and meeting type pre-selected: the way to correct a filing,
   * automatic or not. The caller deletes the written outputs first; their
   * tracking is cleared here so filing writes them afresh. The summary is
   * kept: filing re-summarises only if the meeting type changes, or the
   * client changes and either has an account context.
   */
  refileRecording(id: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE recordings
           SET status = 'to_file', needs_filing = 1, auto_filed = 0, suggested_client_id = client_id,
               markdown_path = NULL, html_path = NULL, apple_note_id = NULL,
               markdown_written_at = NULL, html_written_at = NULL, apple_note_written_at = NULL,
               error = NULL, updated_at = ?
           WHERE id = ? AND status = 'complete' AND summary_text IS NOT NULL`,
        )
        .run(Date.now(), id).changes > 0
    );
  }
}
