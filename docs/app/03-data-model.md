# 03 — Data model

## 3.1 SQLite schema

Database file: `~/Library/Application Support/distill/state.db`. Use `better-sqlite3` — synchronous API is easier to reason about and electron-rebuilds cleanly for Electron's Node version.

```sql
CREATE TABLE recordings (
  id                  TEXT PRIMARY KEY,     -- Plaud file_id
  filename            TEXT NOT NULL,
  plaud_fullname      TEXT,
  duration_seconds    INTEGER,
  start_time          INTEGER,              -- Plaud start_time (epoch seconds)
  end_time            INTEGER,
  filesize_bytes      INTEGER,
  serial_number       TEXT,                 -- Plaud device serial

  synced_at           INTEGER NOT NULL,     -- when poller first saw it (epoch ms)
  status              TEXT NOT NULL,        -- see 3.4 state machine
  client_id           TEXT REFERENCES clients(id),
  meeting_type_id     TEXT REFERENCES meeting_types(id),

  audio_path          TEXT,                 -- local MP3 path once downloaded
  transcript_json     TEXT,                 -- diarised transcript as JSON string (from Python)
  transcript_text     TEXT,                 -- flattened "Speaker N: …" form
  summary_text        TEXT,                 -- Claude's output
  apple_note_id       TEXT,                 -- Notes note ID once written (for linking / dedupe)
  markdown_path       TEXT,                 -- path to on-disk markdown backup

  rating              TEXT,                 -- NULL | 'up' | 'down'
  rating_comment      TEXT,                 -- optional free-text when user rates down

  error               TEXT,                 -- last error message if status=error
  last_step           TEXT,                 -- step the pipeline failed on
  retries             INTEGER NOT NULL DEFAULT 0,

  prompt_snapshot     TEXT,                 -- copy of meeting_types.prompt used at summary time
  model_snapshot      TEXT,                 -- Claude model ID used at summary time
  whisper_snapshot    TEXT,                 -- Whisper model ID used at transcribe time
  pyannote_snapshot   TEXT,                 -- pyannote model ID used at diarise time

  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE clients (
  id          TEXT PRIMARY KEY,             -- slug, e.g. 'acme-corp'
  name        TEXT UNIQUE NOT NULL,         -- display name AND Apple Notes subfolder name
  is_builtin  INTEGER NOT NULL DEFAULT 0,   -- seed-marker, not a lock
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE meeting_types (
  id                  TEXT PRIMARY KEY,
  name                TEXT UNIQUE NOT NULL,
  prompt              TEXT NOT NULL,        -- system prompt used for summarisation
  note_title_template TEXT,                 -- optional override of the default title template
  is_builtin          INTEGER NOT NULL DEFAULT 0,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- History of prompt changes, so we can show "this note was summarised with an older prompt"
-- and so the reflection job has a reference point.
CREATE TABLE prompt_history (
  id                TEXT PRIMARY KEY,       -- uuid
  meeting_type_id   TEXT NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  prompt            TEXT NOT NULL,
  reason            TEXT,                   -- 'seed' | 'manual-edit' | 'accepted-suggestion' | 'rollback'
  created_at        INTEGER NOT NULL
);

-- Pending suggestions from the reflection job. User accepts/edits/dismisses.
CREATE TABLE prompt_suggestions (
  id                  TEXT PRIMARY KEY,
  meeting_type_id     TEXT NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  based_on_prompt_id  TEXT NOT NULL REFERENCES prompt_history(id),
  proposed_prompt     TEXT NOT NULL,
  rationale           TEXT NOT NULL,        -- Claude's explanation of what changed and why
  sample_recordings   TEXT NOT NULL,        -- JSON array of recording IDs that informed the suggestion
  status              TEXT NOT NULL,        -- 'pending' | 'accepted' | 'edited' | 'dismissed'
  created_at          INTEGER NOT NULL,
  resolved_at         INTEGER
);

-- Model update suggestions from the updater jobs.
CREATE TABLE model_suggestions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- 'claude' | 'whisper' | 'pyannote'
  current       TEXT NOT NULL,              -- current configured model ID
  proposed      TEXT NOT NULL,              -- newer model ID discovered
  notes         TEXT,                       -- release notes / rationale if available
  status        TEXT NOT NULL,              -- 'pending' | 'accepted' | 'dismissed' | 'rolled_back'
  discovered_at INTEGER NOT NULL,
  resolved_at   INTEGER
);

-- Job runs per pipeline step, useful for logs and retry bookkeeping.
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,
  recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  step          TEXT NOT NULL,              -- 'download' | 'transcribe' | 'summarise' | 'write_note'
  status        TEXT NOT NULL,              -- 'queued' | 'running' | 'done' | 'error'
  started_at    INTEGER,
  finished_at   INTEGER,
  error         TEXT
);

CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX idx_recordings_status      ON recordings(status);
CREATE INDEX idx_recordings_synced_at   ON recordings(synced_at DESC);
CREATE INDEX idx_recordings_client      ON recordings(client_id);
CREATE INDEX idx_recordings_meeting     ON recordings(meeting_type_id);
CREATE INDEX idx_jobs_recording         ON jobs(recording_id);
CREATE INDEX idx_prompt_sugg_status     ON prompt_suggestions(status);
CREATE INDEX idx_model_sugg_status      ON model_suggestions(status);
```

### Seed data on first run

Neither clients nor meeting types are seeded on fresh installs. New users land with an empty Prompts list and an empty client list, and add their own as they go via Settings -> Prompts and the tag sheet's "+ Add new client…" affordance. The seed code path remains in place so older installs that previously seeded data still type-check; only the default lists are empty.

Earlier shapes shipped a small set of meeting types (`client-call`, `training`, `all-hands`, `ladffa`) plus a couple of work-specific clients. Those carried opinions that didn't generalise to colleagues. The prompts themselves still live in `PROMPTS.md` and remain readable by `readSeedPrompt` so the existing "Revert to default" button on any already-seeded built-ins (on contributor machines that ran an older version) continues to work.

Every seed entry also creates a matching `prompt_history` row with `reason='seed'`.

## 3.2 Snapshotting

When a recording is summarised, snapshot these into the `recordings` row:

- `prompt_snapshot` — the exact prompt text used
- `model_snapshot` — the Claude model ID used
- `whisper_snapshot` — the Whisper model ID used
- `pyannote_snapshot` — the pyannote model ID used

Reason: if the user updates a prompt or switches models, later notes will differ from earlier ones. The snapshot lets us (a) display "summarised with prompt v3, Claude Sonnet 4.6" in the UI, (b) rollback sanely, (c) give the reflection job a fair basis for comparison.

## 3.3 Config file

`~/Library/Application Support/distill/config.json`:

```json
{
  "version": 1,
  "pollIntervalMinutes": 5,
  "paused": false,
  "anthropic": {
    "model": "claude-sonnet-4-6",
    "maxOutputTokens": 8192
  },
  "transcription": {
    "whisperModel": "mlx-community/whisper-large-v3-mlx",
    "language": null,
    "diarisation": {
      "enabled": true,
      "model": "pyannote/speaker-diarization-3.1",
      "minSpeakers": null,
      "maxSpeakers": null
    }
  },
  "appleNotes": {
    "parentFolder": "distill",
    "account": "iCloud"
  },
  "markdown": {
    "enabled": true,
    "baseDir": "~/Documents/distill"
  },
  "cleanup": {
    "audioRetentionDays": 14,
    "completeNotesInDbRetentionDays": null
  },
  "selfMaintaining": {
    "modelUpdateCheckIntervalDays": 7,
    "reflectionEveryNSummariesPerType": 20,
    "reflectionMinSummariesRequired": 10
  },
  "logLevel": "info"
}
```

**Verify**: current Claude Sonnet model ID at `https://docs.claude.com` at build time. The value above is correct as of the spec's authoring date but model IDs roll forward.

**Verify**: current `mlx-community` Whisper model ID at `https://huggingface.co/mlx-community`. Prefer a `turbo` variant if stable.

The `reflectionMinSummariesRequired` floor prevents running reflection on only 1–2 summaries, which would produce low-signal suggestions.

## 3.4 State machine

Per-recording `status` transitions:

```
(poller inserts)
    │
    ▼
  inbox ───(user skips)──► skipped
    │
    │ (user tags: client + meeting_type)
    ▼
  tagged
    │
    ▼
  downloading ──(error)──► error ──(user retries)──► downloading
    │
    ▼
  transcribing ──(error)──► error ──(user retries)──► transcribing
    │
    ▼
  summarising ──(error)──► error ──(user retries)──► summarising
    │
    ▼
  writing_note ──(error)──► error ──(user retries)──► writing_note
    │
    ▼
  complete
```

Rules:

- The only legal entry to the pipeline is via `tagged`. A recording in `inbox` does nothing.
- On error, the pipeline stops. `last_step` records which step failed. The user sees it in the tray's "Errors (N)" submenu and can retry, which re-enters the pipeline at the failed step (not from scratch).
- `skipped` is terminal in v1. A skipped recording is not deleted from SQLite but is hidden from the default inbox view. Settings exposes a "Show skipped" toggle for recovery.
- `complete` is terminal. The recording stays in SQLite for history, rating, and reflection.

## 3.5 Cleanup

A background job runs daily:

- Delete `audio_path` files older than `audioRetentionDays` (default 14). The MP3 is cached for a fortnight in case the user wants to re-run the pipeline; after that it's reclaimable. The SQLite row is kept.
- Do not delete Markdown backups or Apple Notes — the user owns those.
- Optional `completeNotesInDbRetentionDays` (off by default) for users who want SQLite to stay lean after many months.
