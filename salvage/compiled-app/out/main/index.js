"use strict";
const electron = require("electron");
const node_path = require("node:path");
const pino = require("pino");
const node_fs = require("node:fs");
const node_os = require("node:os");
const Database = require("better-sqlite3");
const node_crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const keytar = require("keytar");
const promises = require("node:fs/promises");
const node_child_process = require("node:child_process");
const node_stream = require("node:stream");
const promises$1 = require("node:stream/promises");
const marked = require("marked");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const keytar__namespace = /* @__PURE__ */ _interopNamespaceDefault(keytar);
const APP_NAME = "distill";
const LEGACY_APP_NAME = "Plaud Local";
function resolveAppSupportDir() {
  const newPath = node_path.join(node_os.homedir(), "Library", "Application Support", APP_NAME);
  const legacyPath = node_path.join(node_os.homedir(), "Library", "Application Support", LEGACY_APP_NAME);
  if (!node_fs.existsSync(newPath) && node_fs.existsSync(legacyPath)) return legacyPath;
  return newPath;
}
function resolveLogsDir() {
  const newPath = node_path.join(node_os.homedir(), "Library", "Logs", APP_NAME);
  const legacyPath = node_path.join(node_os.homedir(), "Library", "Logs", LEGACY_APP_NAME);
  if (!node_fs.existsSync(newPath) && node_fs.existsSync(legacyPath)) return legacyPath;
  return newPath;
}
const APP_SUPPORT_DIR = resolveAppSupportDir();
const LOGS_DIR = resolveLogsDir();
const appSupportDir = () => APP_SUPPORT_DIR;
const logsDir = () => LOGS_DIR;
const configFile = () => node_path.join(appSupportDir(), "config.json");
const stateDbFile = () => node_path.join(appSupportDir(), "state.db");
const audioDir = () => node_path.join(appSupportDir(), "audio");
const userVocabularyDir = () => node_path.join(appSupportDir(), "vocabulary");
const logFile = () => node_path.join(logsDir(), "app.log");
const expandHome = (p) => p.startsWith("~/") ? node_path.join(node_os.homedir(), p.slice(2)) : p;
function createLogger(cfg) {
  node_fs.mkdirSync(logsDir(), { recursive: true });
  const transport = cfg.pretty ? {
    targets: [
      {
        target: "pino-pretty",
        level: cfg.level,
        options: { colorize: true, translateTime: "SYS:standard" }
      },
      {
        target: "pino/file",
        level: cfg.level,
        options: { destination: logFile(), mkdir: true }
      }
    ]
  } : {
    target: "pino/file",
    options: { destination: logFile(), mkdir: true }
  };
  return pino({
    level: cfg.level,
    transport,
    base: { app: "distill" }
  });
}
const PAUSABLE_STEPS = [
  "polling",
  "download",
  "transcribe",
  "summarise"
];
function defaultPauseConfig() {
  return {
    all: false,
    polling: false,
    download: false,
    transcribe: false,
    summarise: false
  };
}
function normalisePause(raw) {
  if (raw === true) return { ...defaultPauseConfig(), all: true };
  if (raw === false || raw == null) return defaultPauseConfig();
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return defaultPauseConfig();
  }
  const obj = raw;
  const bool = (k) => obj[k] === true;
  return {
    all: bool("all"),
    polling: bool("polling"),
    download: bool("download"),
    transcribe: bool("transcribe"),
    summarise: bool("summarise")
  };
}
function shouldRunStep(cfg, step) {
  if (cfg.all) return false;
  return !cfg[step];
}
function pausedSteps(cfg) {
  if (cfg.all) return [...PAUSABLE_STEPS];
  return PAUSABLE_STEPS.filter((s) => cfg[s]);
}
const STATUS_LABEL = {
  polling: "polling",
  download: "downloads",
  transcribe: "transcribe",
  summarise: "summarise"
};
function formatPauseStatus(cfg) {
  if (cfg.all) return "Paused";
  const steps = pausedSteps(cfg);
  if (steps.length === 0) return null;
  if (steps.length === 1) return `Paused (${STATUS_LABEL[steps[0]]})`;
  return `Paused (${steps.map((s) => STATUS_LABEL[s]).join(", ")})`;
}
class ConfigMissingError extends Error {
  constructor(expectedPath, examplePath) {
    super(
      `Config file not found at ${expectedPath}. An example has been placed next to it at ${examplePath}. Copy it to config.json and edit before restarting.`
    );
    this.expectedPath = expectedPath;
    this.examplePath = examplePath;
    this.name = "ConfigMissingError";
  }
}
function loadConfig(resourcesDir) {
  const path2 = configFile();
  node_fs.mkdirSync(appSupportDir(), { recursive: true });
  if (!node_fs.existsSync(path2)) {
    const bundledExample = node_path.join(resourcesDir, "example.config.json");
    if (!node_fs.existsSync(bundledExample)) {
      const examplePath = node_path.join(appSupportDir(), "example.config.json");
      throw new ConfigMissingError(path2, examplePath);
    }
    node_fs.copyFileSync(bundledExample, path2);
  }
  const raw = node_fs.readFileSync(path2, "utf-8");
  const parsed = JSON.parse(raw);
  return normaliseConfig(parsed);
}
function normaliseConfig(cfg) {
  const defaultMarkdownDir = expandHome(
    cfg.outputs?.markdown?.dir ?? cfg.markdownBaseDir ?? "~/Documents/distill"
  );
  const legacyGlobalIncludeTranscript = cfg.outputs?.includeTranscript;
  const defaultIncludeTranscript = legacyGlobalIncludeTranscript ?? true;
  const outputs = {
    markdown: {
      enabled: cfg.outputs?.markdown?.enabled ?? true,
      dir: defaultMarkdownDir,
      includeTranscript: cfg.outputs?.markdown?.includeTranscript ?? defaultIncludeTranscript
    },
    html: {
      enabled: cfg.outputs?.html?.enabled ?? false,
      dir: expandHome(cfg.outputs?.html?.dir ?? defaultMarkdownDir),
      includeTranscript: cfg.outputs?.html?.includeTranscript ?? defaultIncludeTranscript
    },
    appleNotes: {
      enabled: cfg.outputs?.appleNotes?.enabled ?? false,
      parentFolder: cfg.outputs?.appleNotes?.parentFolder ?? "distill",
      includeTranscript: cfg.outputs?.appleNotes?.includeTranscript ?? defaultIncludeTranscript
    }
  };
  return {
    version: cfg.version ?? 1,
    ollama: cfg.ollama ? {
      ...cfg.ollama,
      // One-time bump of contextWindow from the old 32k default to
      // 64k, applied only when the on-disk value is exactly the old
      // default. Manually-set values (e.g. 16384 or 131072) are
      // preserved. Why bump: long meetings (~2h+) at qwen2.5:32b's
      // typical token rate were brushing or exceeding 32k, causing
      // Ollama to silently truncate the start of the input. 64k
      // gives ~6h of conversational speech of headroom against the
      // model's 131k native context. Costs ~4-6GB more unified
      // memory while the model is resident.
      contextWindow: cfg.ollama.contextWindow === 32768 ? 65536 : cfg.ollama.contextWindow
    } : {
      host: "http://localhost:11434",
      model: "qwen2.5:32b",
      contextWindow: 65536,
      temperature: 0.3,
      // 5 minutes: long enough that back-to-back summaries reuse the
      // loaded model, short enough that idle daytime hours get the
      // ~20GB of unified memory back. See BACKLOG "Performance under
      // load" for the broader story; this default is the lowest-cost
      // single change for the laggy-laptop-during-processing problem.
      keepAlive: "5m"
    },
    pollIntervalMinutes: cfg.pollIntervalMinutes ?? 5,
    paused: normalisePause(cfg.paused),
    whisperModel: cfg.whisperModel ?? "mlx-community/whisper-large-v3-mlx",
    outputs,
    audioRetentionDays: normaliseAudioRetentionDays(cfg.audioRetentionDays),
    autoDismissCompleteMinutes: typeof cfg.autoDismissCompleteMinutes === "number" ? cfg.autoDismissCompleteMinutes : 10,
    logLevel: cfg.logLevel ?? "info"
  };
}
function normaliseAudioRetentionDays(raw) {
  if (raw === null || raw === void 0) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return Math.floor(raw);
}
function saveConfig(cfg) {
  const path2 = configFile();
  node_fs.mkdirSync(node_path.dirname(path2), { recursive: true });
  const { markdownBaseDir: _drop, ...toWrite } = cfg;
  node_fs.writeFileSync(path2, JSON.stringify(toWrite, null, 2) + "\n", "utf-8");
}
function nextNeededStep(row) {
  if (!row.audio_path) return "download";
  if (!row.transcript_text) return "transcribe";
  if (!row.summary_text) return "summarise";
  return "write";
}
const MIGRATIONS = [
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
    `
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
    `
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
    `
  },
  {
    version: 4,
    sql: `
      -- Distinguishes recordings pulled from Plaud cloud from ones the user
      -- dragged in from disk (Teams recordings, Zoom exports, voice memos).
      -- Locally imported rows have their audio_path set at insert time and
      -- skip the download step.
      ALTER TABLE recordings ADD COLUMN source TEXT NOT NULL DEFAULT 'plaud';
    `
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
    `
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
    `
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
    `
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
    `
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
    `
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
    `
  }
];
function openDatabase(path2) {
  const dbPath = stateDbFile();
  node_fs.mkdirSync(node_path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare("SELECT version FROM migrations").all().map((r) => r.version)
  );
  const apply = db.transaction((m) => {
    db.exec(m.sql);
    db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(m.version, Date.now());
  });
  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      apply(m);
    }
  }
}
class State {
  constructor(db) {
    this.db = db;
  }
  close() {
    this.db.close();
  }
  // --- clients -------------------------------------------------------------
  listClients() {
    return this.db.prepare("SELECT * FROM clients ORDER BY sort_order, name").all();
  }
  getClient(id) {
    return this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id);
  }
  upsertClient(row) {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO clients (id, name, is_builtin, sort_order, created_at)
         VALUES (@id, @name, @is_builtin, @sort_order, @created_at)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order`
    ).run({ ...row, created_at: now });
  }
  // --- meeting types -------------------------------------------------------
  listMeetingTypes() {
    return this.db.prepare("SELECT * FROM meeting_types ORDER BY sort_order, name").all();
  }
  getMeetingType(id) {
    return this.db.prepare("SELECT * FROM meeting_types WHERE id = ?").get(id);
  }
  upsertMeetingType(row) {
    const now = Date.now();
    this.db.prepare(
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
           updated_at=excluded.updated_at`
    ).run({ ...row, created_at: now, updated_at: now });
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
  deleteMeetingType(id) {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT is_builtin FROM meeting_types WHERE id = ?"
      ).get(id);
      if (!existing) return { kind: "not-found" };
      if (existing.is_builtin === 1) return { kind: "builtin" };
      const detach = this.db.prepare(
        "UPDATE recordings SET meeting_type_id = NULL WHERE meeting_type_id = ?"
      ).run(id);
      const detachedCount = detach.changes ?? 0;
      this.db.prepare("DELETE FROM meeting_types WHERE id = ?").run(id);
      return { kind: "deleted", detachedCount };
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
  updateMeetingType(id, patch) {
    const fields = [];
    const params = { id, updated_at: Date.now() };
    if (patch.name !== void 0) {
      fields.push("name = @name");
      params.name = patch.name;
    }
    if (patch.prompt !== void 0) {
      fields.push("prompt = @prompt");
      params.prompt = patch.prompt;
    }
    if (fields.length === 0) return false;
    fields.push("updated_at = @updated_at");
    const result = this.db.prepare(`UPDATE meeting_types SET ${fields.join(", ")} WHERE id = @id`).run(params);
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
  revertMeetingTypeToBuiltin(id, seededPrompt, seededPromptHash) {
    const result = this.db.prepare(
      `UPDATE meeting_types
         SET prompt = @prompt,
             original_prompt_hash = @hash,
             updated_at = @updated_at
         WHERE id = @id`
    ).run({
      id,
      prompt: seededPrompt,
      hash: seededPromptHash,
      updated_at: Date.now()
    });
    return result.changes > 0;
  }
  // --- recordings ----------------------------------------------------------
  recordingExists(id) {
    const hit = this.db.prepare("SELECT 1 as one FROM recordings WHERE id = ?").get(id);
    return hit !== void 0;
  }
  insertRecording(r) {
    const now = Date.now();
    this.db.prepare(
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
         )`
    ).run({ ...r, created_at: now, updated_at: now });
  }
  updateRecording(id, patch) {
    const keys = Object.keys(patch).filter((k) => k !== "id");
    if (keys.length === 0) return;
    const set = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE recordings SET ${set}, updated_at = @updated_at WHERE id = @id`).run({ ...patch, id, updated_at: Date.now() });
  }
  listInbox() {
    return this.db.prepare(
      "SELECT * FROM recordings WHERE status = 'inbox' ORDER BY synced_at DESC"
    ).all();
  }
  getRecording(id) {
    return this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
  }
  /**
   * Mark a recording as skipped — removes it from every UI list. Legal from
   * any terminal or user-actionable state. Not legal from an actively-running
   * pipeline state (use cancel for that).
   */
  skipRecording(id) {
    const result = this.db.prepare(
      `UPDATE recordings SET status = 'skipped', updated_at = ?
         WHERE id = ? AND status IN ('inbox', 'error', 'cancelled', 'complete')`
    ).run(Date.now(), id);
    return result.changes > 0;
  }
  // --- pipeline transitions ----------------------------------------------
  /**
   * Unconditionally set status (and optionally other fields) on a recording.
   * Used by the pipeline worker to walk a row through the step states.
   * Callers are expected to already know the current status is valid; this
   * method does not enforce a state machine, only records the transition.
   */
  setStatus(id, status, patch) {
    const now = Date.now();
    const fields = ["status = @status", "updated_at = @updated_at"];
    const params = { id, status, updated_at: now };
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = @${k}`);
        params[k] = v;
      }
    }
    this.db.prepare(`UPDATE recordings SET ${fields.join(", ")} WHERE id = @id`).run(params);
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
  claimNextTagged(allowedSteps) {
    return this.db.transaction(() => {
      const rows = this.db.prepare(
        `SELECT * FROM recordings
           WHERE status = 'tagged'
           ORDER BY synced_at ASC`
      ).all();
      for (const row of rows) {
        const nextStep = nextNeededStep(row);
        if (allowedSteps && !allowedSteps.has(nextStep)) continue;
        const targetStatus = nextStep === "download" ? "downloading" : nextStep === "transcribe" ? "transcribing" : nextStep === "summarise" ? "summarising" : "writing";
        this.db.prepare(
          `UPDATE recordings SET status = ?, updated_at = ? WHERE id = ?`
        ).run(targetStatus, Date.now(), row.id);
        return row;
      }
      return void 0;
    })();
  }
  /**
   * On startup, any recording that is in a pipeline-running state was
   * interrupted (the process running it is gone). Revert them to `tagged`
   * so the worker picks them up again. The idempotent step runner will
   * skip any step whose output field is already populated, so prior work
   * is preserved.
   */
  recoverInterrupted() {
    const rows = this.db.prepare(
      `SELECT id FROM recordings WHERE status IN ('downloading','transcribing','summarising','writing')`
    ).all();
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const stmt = this.db.prepare(
      `UPDATE recordings SET status = 'tagged', updated_at = ? WHERE id = ?`
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
  cancel(id) {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM recordings WHERE id = ?").get(id);
      if (!row) return void 0;
      const cancellable = [
        "tagged",
        "downloading",
        "transcribing",
        "summarising",
        "writing"
      ];
      if (!cancellable.includes(row.status)) return void 0;
      this.db.prepare(
        `UPDATE recordings SET status = 'cancelled', updated_at = ? WHERE id = ?`
      ).run(Date.now(), id);
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
  retry(id) {
    const result = this.db.prepare(
      `UPDATE recordings
         SET status = 'tagged', error = NULL, is_auth_error = 0, updated_at = ?
         WHERE id = ? AND status IN ('error', 'cancelled')`
    ).run(Date.now(), id);
    return result.changes > 0;
  }
  // --- joined reads ------------------------------------------------------
  joinSelect = `SELECT r.*, c.name AS client_name, mt.name AS meeting_type_name
     FROM recordings r
     LEFT JOIN clients       c  ON c.id  = r.client_id
     LEFT JOIN meeting_types mt ON mt.id = r.meeting_type_id`;
  getRecordingJoined(id) {
    return this.db.prepare(`${this.joinSelect} WHERE r.id = ?`).get(id);
  }
  /**
   * Everything the inbox window shows: inbox / in-flight / error / cancelled
   * / complete. Skipped rows are excluded — they're gone from the user's
   * perspective.
   */
  listActiveJoined() {
    return this.db.prepare(
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
           r.updated_at DESC`
    ).all();
  }
  /**
   * Tag an inbox recording: attach client + meeting type and transition to
   * `tagged`. The pipeline (M2) picks up `tagged` rows and processes them.
   * Returns true iff the recording was actually transitioned (prevents
   * double-tagging via rapid clicks).
   */
  tagRecording(id, clientId, meetingTypeId) {
    const result = this.db.prepare(
      `UPDATE recordings
         SET client_id = ?, meeting_type_id = ?, status = 'tagged', updated_at = ?
         WHERE id = ? AND status = 'inbox'`
    ).run(clientId, meetingTypeId, Date.now(), id);
    return result.changes > 0;
  }
  inboxCount() {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM recordings WHERE status = 'inbox'").get();
    return row?.n ?? 0;
  }
  errorCount() {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM recordings WHERE status = 'error'").get();
    return row?.n ?? 0;
  }
  /**
   * Count of recordings currently in pipeline-running states plus tagged
   * (queued). Returned as {@link ProcessingSummary}. Used by the tray to
   * show a live processing line. Cheap - one small aggregate query.
   */
  processingSummary() {
    const row = this.db.prepare(
      `SELECT
           (SELECT status FROM recordings
              WHERE status IN ('downloading','transcribing','summarising','writing')
              ORDER BY updated_at DESC LIMIT 1) AS current,
           (SELECT COUNT(*) FROM recordings
              WHERE status IN ('downloading','transcribing','summarising','writing')) AS running,
           (SELECT COUNT(*) FROM recordings WHERE status = 'tagged') AS queued`
    ).get();
    return {
      currentStatus: row?.current ?? null,
      running: row?.running ?? 0,
      queued: row?.queued ?? 0
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
  sweepCompletedOlderThan(minutes) {
    if (minutes <= 0) return 0;
    const cutoff = Date.now() - minutes * 6e4;
    const result = this.db.prepare(
      `UPDATE recordings
         SET status = 'skipped', updated_at = ?
         WHERE status = 'complete' AND updated_at < ?`
    ).run(Date.now(), cutoff);
    return result.changes;
  }
  // --- app state -----------------------------------------------------------
  /**
   * Read a single app_state value. Returns undefined if the key is not set.
   * Used for install-level flags (e.g. hasCompletedInitialPoll) that don't
   * belong in config.json because they're never user-edited.
   */
  getAppState(key) {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key);
    return row?.value;
  }
  setAppState(key, value) {
    this.db.prepare(
      `INSERT INTO app_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value);
  }
}
function hashPrompt(prompt) {
  return node_crypto.createHash("sha256").update(prompt, "utf8").digest("hex");
}
const SEED_CLIENTS = [];
function parsePromptsMarkdown(md) {
  const out = /* @__PURE__ */ new Map();
  for (const entry of parsePromptsMarkdownDetailed(md)) {
    out.set(entry.id, entry.prompt);
  }
  return out;
}
function parsePromptsMarkdownDetailed(md) {
  const out = [];
  const headingRegex = /^##\s+\d+\.\s+`([a-z0-9-]+)`(.*)$/gm;
  const matches = [...md.matchAll(headingRegex)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index == null) continue;
    const id = m[1];
    if (!id) continue;
    const tail = (m[2] ?? "").trim();
    let name = tail.replace(/^[\u2014\u2013-]\s*/, "").trim();
    if (name.length === 0) {
      name = id.split("-").map((w) => w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)).join(" ");
    }
    const sectionStart = m.index;
    const nextMatch = matches[i + 1];
    const sectionEnd = nextMatch?.index ?? md.length;
    const section = md.slice(sectionStart, sectionEnd);
    const fence = section.match(/^(`{3,})\s*\n([\s\S]*?)\n\1\s*$/m);
    if (fence && fence[2] != null) {
      out.push({ id, name, prompt: fence[2] });
    }
  }
  return out;
}
function findPromptsMarkdown(resourcesDir) {
  const packaged = node_path.join(resourcesDir, "PROMPTS.md");
  const dev = node_path.resolve(resourcesDir, "..", "..", "..", "docs", "app", "PROMPTS.md");
  try {
    return node_fs.readFileSync(packaged, "utf-8");
  } catch (packagedErr) {
    try {
      return node_fs.readFileSync(dev, "utf-8");
    } catch (devErr) {
      throw new Error(
        `Could not find PROMPTS.md — the seed file for built-in meeting type prompts.

This is expected in fresh packaged installs (no built-in prompts to revert).
If you're seeing this from a Revert button, the prompt was probably migrated
from a contributor's database; try editing the prompt text directly instead,
or delete and re-create the prompt as a user-created one.

  Tried packaged: ${packaged}
  Tried dev:      ${dev}
  Packaged read failed: ${packagedErr.message}
  Dev read failed:      ${devErr.message}`
      );
    }
  }
}
function seedIfEmpty(state2, _resourcesDir) {
  const notes = [];
  let seeded = false;
  if (state2.listClients().length === 0) {
    for (const c of SEED_CLIENTS) {
      state2.upsertClient({ ...c, is_builtin: 1 });
    }
    notes.push(`Seeded ${SEED_CLIENTS.length} clients`);
    seeded = true;
  }
  return { seeded, notes };
}
function readSeedPrompt(resourcesDir, id) {
  const md = findPromptsMarkdown(resourcesDir);
  return parsePromptsMarkdown(md).get(id);
}
function computeTrayState(inputs) {
  if (inputs.processingRunning) return "processing";
  if (inputs.paused) return "paused";
  if (inputs.errorCount > 0) return "error";
  return "idle";
}
const TIP_JAR_URL = "https://buymeacoffee.com/distill";
const TIP_JAR_THRESHOLD = 50;
const KEY_COUNT = "tip_jar_completion_count";
const KEY_BANNER_DISMISSED = "tip_jar_banner_dismissed";
const KEY_THRESHOLD_NOTIFIED = "tip_jar_threshold_notified";
function readTipJarStatus(state2) {
  const completionCount = readInt(state2, KEY_COUNT, 0);
  const bannerDismissed = readBool(state2, KEY_BANNER_DISMISSED);
  const thresholdNotified = readBool(state2, KEY_THRESHOLD_NOTIFIED);
  return {
    completionCount,
    bannerDismissed,
    thresholdNotified,
    shouldShowBanner: completionCount >= TIP_JAR_THRESHOLD && !bannerDismissed,
    url: TIP_JAR_URL,
    threshold: TIP_JAR_THRESHOLD
  };
}
function recordCompletion(state2) {
  const previousCount = readInt(state2, KEY_COUNT, 0);
  const newCount = previousCount + 1;
  state2.setAppState(KEY_COUNT, String(newCount));
  if (newCount >= TIP_JAR_THRESHOLD && !readBool(state2, KEY_THRESHOLD_NOTIFIED)) {
    state2.setAppState(KEY_THRESHOLD_NOTIFIED, "1");
    return { kind: "threshold-just-hit", count: newCount };
  }
  if (newCount >= TIP_JAR_THRESHOLD) {
    return { kind: "already-past-threshold", count: newCount };
  }
  return { kind: "incremented", count: newCount };
}
function dismissBanner(state2) {
  state2.setAppState(KEY_BANNER_DISMISSED, "1");
}
function readInt(state2, key, fallback) {
  const raw = state2.getAppState(key);
  if (raw === void 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
function readBool(state2, key) {
  return state2.getAppState(key) === "1";
}
function createTray(ctx2) {
  const iconCache = /* @__PURE__ */ new Map();
  const iconFor = (s) => {
    const cached = iconCache.get(s);
    if (cached) return cached;
    const built = loadTrayIcon(ctx2.resourcesDir, s, ctx2.logger);
    iconCache.set(s, built);
    return built;
  };
  const tray = new electron.Tray(iconFor("idle"));
  tray.setToolTip("distill");
  let lastPoll = null;
  let ollamaWarning = null;
  let currentState = "idle";
  const rebuild = () => {
    const inbox = ctx2.state.inboxCount();
    const errors = ctx2.state.errorCount();
    const processing = ctx2.state.processingSummary();
    const cfg = ctx2.getConfig();
    const anyPaused = cfg.paused.all || pausedSteps(cfg.paused).length > 0;
    const nextState = computeTrayState({
      processingRunning: processing.running > 0,
      paused: anyPaused,
      errorCount: errors
    });
    if (nextState !== currentState) {
      tray.setImage(iconFor(nextState));
      currentState = nextState;
    }
    let title = "";
    if (inbox > 0) title += ` ${inbox}`;
    if (errors > 0) title += ` ⚠`;
    tray.setTitle(title);
    const template = [
      { label: statusLine(inbox, errors, lastPoll, processing, cfg.paused), enabled: false }
    ];
    if (ollamaWarning) {
      template.push({ type: "separator" });
      template.push({ label: ollamaWarning, enabled: false });
    }
    template.push(
      { type: "separator" },
      {
        label: `Inbox${inbox > 0 ? ` (${inbox})` : ""}…`,
        click: () => ctx2.onOpenInbox(tray.getBounds())
      },
      { type: "separator" },
      {
        label: "Sync now",
        click: () => {
          void ctx2.onSyncNow();
        }
      },
      buildPauseSubmenu(cfg.paused, ctx2.onPauseChange),
      { type: "separator" },
      {
        label: "Settings…",
        click: () => ctx2.onOpenSettings()
      },
      {
        label: "Open logs folder",
        click: () => {
          electron.shell.openPath(logsDir()).catch(
            (e) => ctx2.logger.warn({ err: String(e) }, "failed to open logs folder")
          );
        }
      },
      {
        label: "Open config folder",
        click: () => {
          electron.shell.openPath(node_path.join(electron.app.getPath("home"), "Library", "Application Support", "distill")).catch((e) => ctx2.logger.warn({ err: String(e) }, "failed to open config folder"));
        }
      },
      { type: "separator" },
      // Tip-jar entry. Always visible; the user can click it any time
      // they fancy supporting development without waiting for the
      // 50-summary banner. Routed through shell.openExternal directly
      // here rather than via IPC because the tray runs in main and
      // there's no renderer to notify.
      {
        label: "Buy me a coffee…",
        click: () => {
          electron.shell.openExternal(TIP_JAR_URL).catch(
            (e) => ctx2.logger.warn(
              { err: String(e), url: TIP_JAR_URL },
              "failed to open tip-jar URL from tray menu"
            )
          );
        }
      },
      { type: "separator" },
      { label: "Quit distill", role: "quit" }
    );
    tray.setContextMenu(electron.Menu.buildFromTemplate(template));
  };
  rebuild();
  return {
    refresh: rebuild,
    setLastPoll: (r) => {
      lastPoll = r;
      rebuild();
    },
    setOllamaWarning: (m) => {
      ollamaWarning = m;
      rebuild();
    },
    destroy: () => tray.destroy()
  };
}
function statusLine(inbox, errors, last, processing, paused) {
  const bits = [];
  const pauseLabel = formatPauseStatus(paused);
  if (processing.currentStatus) {
    bits.push(humanProcessingLabel(processing.currentStatus));
  } else if (pauseLabel) {
    bits.push(pauseLabel);
  } else if (!last) {
    bits.push("Starting…");
  } else if (last.kind === "ok") {
    bits.push(`Synced ${formatRelative(last.at)}`);
  } else if (last.kind === "skipped-paused") {
    bits.push("Paused");
  } else {
    bits.push(`Sync failed ${formatRelative(last.at)}`);
  }
  if (processing.queued > 0) {
    bits.push(`${processing.queued} queued`);
  }
  if (inbox > 0) bits.push(`${inbox} in inbox`);
  if (errors > 0) bits.push(`${errors} error${errors === 1 ? "" : "s"}`);
  return bits.join(" · ");
}
function buildPauseSubmenu(paused, onPauseChange) {
  const stepLabels = {
    polling: "Polling",
    download: "Downloads",
    transcribe: "Transcription",
    summarise: "Summarisation"
  };
  const submenu = [
    {
      label: "All processing",
      type: "checkbox",
      checked: paused.all,
      click: () => onPauseChange({ ...paused, all: !paused.all })
    },
    { type: "separator" },
    ...PAUSABLE_STEPS.map((step) => ({
      label: stepLabels[step],
      type: "checkbox",
      // When master is on, show per-step items as unchecked + disabled.
      // Their stored values are preserved so flipping master off restores
      // them; we just don't expose that visually because it would imply
      // they have effect right now.
      checked: paused.all ? false : paused[step],
      enabled: !paused.all,
      click: () => onPauseChange({ ...paused, [step]: !paused[step] })
    }))
  ];
  return {
    label: "Pause",
    submenu
  };
}
function humanProcessingLabel(s) {
  switch (s) {
    case "downloading":
      return "Downloading…";
    case "transcribing":
      return "Transcribing…";
    case "summarising":
      return "Summarising…";
    case "writing":
      return "Writing…";
  }
}
function formatRelative(epochMs) {
  const s = Math.max(0, Math.round((Date.now() - epochMs) / 1e3));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
const STATE_COLOUR = {
  processing: "#22c55e",
  // green-500
  paused: "#f59e0b",
  // amber-500
  error: "#ef4444"
  // red-500
};
function loadTrayIcon(resourcesDir, state2, logger2) {
  const filename = PNG_FILENAME[state2];
  const iconPath = node_path.join(resourcesDir, "icons", filename);
  const fromFile = electron.nativeImage.createFromPath(iconPath);
  if (!fromFile.isEmpty()) {
    if (state2 === "idle") fromFile.setTemplateImage(true);
    return fromFile;
  }
  logger2?.warn(
    { state: state2, iconPath },
    `Tray icon PNG not found. Run: python3 scripts/generate-tray-icons.py (from packages/app) to generate all four state icons at 22px + @2x.`
  );
  return renderMicrophoneIconSvg(state2, logger2);
}
const PNG_FILENAME = {
  idle: "trayTemplate.png",
  processing: "trayProcessing.png",
  paused: "trayPaused.png",
  error: "trayError.png"
};
function renderMicrophoneIconSvg(state2, logger2) {
  const isTemplate = state2 === "idle";
  const fill = isTemplate ? "black" : STATE_COLOUR[state2];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="5" y="1.5" width="6" height="9" rx="3" fill="${fill}"/><path d="M3 7.5 v1 a5 5 0 0 0 10 0 v-1" stroke="${fill}" stroke-width="1.5" fill="none" stroke-linecap="round"/><rect x="7" y="13" width="2" height="2" fill="${fill}"/></svg>`;
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const img = electron.nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) {
    logger2?.warn(
      { state: state2, svgLen: svg.length },
      "tray icon: SVG fallback also produced an empty NativeImage. Run the Python generator to produce PNG files (see previous warning)."
    );
    return electron.nativeImage.createEmpty();
  }
  img.setTemplateImage(isTemplate);
  return img;
}
class OllamaClient {
  constructor(host) {
    this.host = host;
  }
  /**
   * List installed models from /api/tags. Used by the Performance
   * settings pane to populate the model dropdown. Returns a tagged
   * result so the caller can distinguish "Ollama is up but no
   * models pulled" from "Ollama is unreachable". Same timeout
   * envelope as preflight — we don't want a slow Ollama to make
   * the Settings window feel laggy.
   */
  async listTags(timeoutMs = 3e3) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, models: data.models ?? [] };
    } catch (e) {
      const err = e;
      const detail = err.code === "ECONNREFUSED" ? "Connection refused" : err.message ?? String(e);
      return { ok: false, reason: "unreachable", detail };
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Check Ollama is reachable and the configured model is installed.
   * Returns a tagged result rather than throwing so the caller can surface
   * a clear, actionable message in the tray.
   */
  async preflight(model, timeoutMs = 3e3) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}` };
      }
      const data = await res.json();
      const available = data.models.map((m) => m.name);
      const has = available.some((n) => n === model || n === `${model}:latest`);
      if (!has) {
        return { ok: false, reason: "model-missing", model, available };
      }
      return { ok: true, model };
    } catch (e) {
      const err = e;
      const detail = err.code === "ECONNREFUSED" ? "Connection refused" : err.message ?? String(e);
      return { ok: false, reason: "unreachable", detail };
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Chat completion with streaming. Ollama's /api/chat endpoint returns
   * newline-delimited JSON chunks when stream=true; we accumulate them
   * into a full OllamaChatResponse.
   *
   * Why streaming rather than blocking? Long generations against a large
   * transcript (100k+ chars) can take many minutes. Node's undici fetch
   * imposes a ~5 minute bodyTimeout on an idle socket, so a blocking
   * request that spends 10 minutes generating dies with "fetch failed".
   * Streaming keeps the socket active on every token so the timeout
   * never fires.
   *
   * The optional AbortSignal cancels mid-stream. onChunk, when provided,
   * fires for each partial message.content delta — useful for a
   * progress bar in future milestones.
   */
  async chat(req, signal, onChunk) {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req, stream: true }),
      signal
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
    }
    if (!res.body) {
      throw new Error("Ollama response had no body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let accumulated = "";
    let finalChunk = null;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new Error(`Ollama stream error: ${parsed.error}`);
          }
          const delta = parsed.message?.content ?? "";
          if (delta) {
            accumulated += delta;
            onChunk?.(accumulated);
          }
          if (parsed.done) {
            finalChunk = {
              model: parsed.model,
              created_at: parsed.created_at,
              done: true,
              total_duration: parsed.total_duration,
              eval_count: parsed.eval_count
            };
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
      }
    }
    if (!finalChunk) {
      throw new Error("Ollama stream ended without a done=true chunk");
    }
    return {
      model: finalChunk.model ?? req.model,
      created_at: finalChunk.created_at ?? (/* @__PURE__ */ new Date()).toISOString(),
      message: { role: "assistant", content: accumulated },
      done: true,
      total_duration: finalChunk.total_duration,
      eval_count: finalChunk.eval_count
    };
  }
}
function preflightMessage(r) {
  if (r.reason === "unreachable") {
    return `Ollama is not reachable (${r.detail}). Start the Ollama app or run: ollama serve`;
  }
  return `Ollama is running but the model "${r.model}" is not installed. Pull it with: ollama pull ${r.model}`;
}
const BASE_URLS = {
  us: "https://api.plaud.ai",
  eu: "https://api-euc1.plaud.ai"
};
const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1e3;
class PlaudAuth {
  config;
  constructor(config) {
    this.config = config;
  }
  async getToken() {
    const cached = this.config.getToken();
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken;
    }
    return this.login();
  }
  async login() {
    const creds = this.config.getCredentials();
    if (!creds) {
      throw new Error("No credentials configured. Run `plaud login` first.");
    }
    const baseUrl = BASE_URLS[creds.region] ?? BASE_URLS["us"];
    const body = new URLSearchParams({
      username: creds.email,
      password: creds.password
    });
    const res = await fetch(`${baseUrl}/auth/access-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString()
    });
    const data = await res.json();
    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg || `Login failed (status ${data.status})`);
    }
    const decoded = this.decodeJwtExpiry(data.access_token);
    const tokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || "Bearer",
      issuedAt: decoded.iat * 1e3,
      expiresAt: decoded.exp * 1e3
    };
    this.config.saveToken(tokenData);
    return data.access_token;
  }
  isExpiringSoon(token) {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }
  decodeJwtExpiry(jwt) {
    const parts = jwt.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
function isRegionRedirect(v) {
  if (typeof v !== "object" || v === null) return false;
  const o = v;
  return o.status === -302;
}
class PlaudClient {
  auth;
  region;
  constructor(auth, region = "us") {
    this.auth = auth;
    this.region = region;
  }
  get baseUrl() {
    return BASE_URLS[this.region] ?? BASE_URLS["us"];
  }
  async request(path2, options) {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path2}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options?.headers
      }
    });
    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (isRegionRedirect(data)) {
      const domain = data.data?.domains?.api;
      if (domain) {
        this.region = domain.includes("euc1") ? "eu" : "us";
        return this.request(path2, options);
      }
    }
    return data;
  }
  async listRecordings() {
    const data = await this.request("/file/simple/web");
    const list = data.data_file_list ?? data.data ?? [];
    return list.filter((r) => !r.is_trash);
  }
  async getRecording(id) {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;
    let transcript = "";
    const preDownload = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? "";
      if (content.length > transcript.length) transcript = content;
    }
    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript
    };
  }
  async getUserInfo() {
    const data = await this.request("/user/me");
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? "unknown"
    };
  }
  async downloadAudio(id) {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }
  async getMp3Url(id) {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/Plaud API error:\s*404\b/i.test(msg)) return null;
      throw e;
    }
  }
}
const DEFAULT_DIR = path__namespace.join(os__namespace.homedir(), ".plaud");
const CONFIG_FILE$1 = "config.json";
class FileCredentialStore {
  dir;
  constructor(dir) {
    this.dir = dir ?? DEFAULT_DIR;
  }
  filePath() {
    return path__namespace.join(this.dir, CONFIG_FILE$1);
  }
  load() {
    try {
      const raw = fs__namespace.readFileSync(this.filePath(), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  save(data) {
    fs__namespace.mkdirSync(this.dir, { recursive: true, mode: 448 });
    const existing = this.load();
    const merged = { ...existing, ...data };
    fs__namespace.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 384 });
  }
  getCredentials() {
    return this.load().credentials;
  }
  saveCredentials(credentials) {
    this.save({ credentials });
  }
  clearCredentials() {
    const data = this.load();
    delete data.credentials;
    fs__namespace.mkdirSync(this.dir, { recursive: true, mode: 448 });
    fs__namespace.writeFileSync(this.filePath(), JSON.stringify(data, null, 2), { mode: 384 });
  }
  getToken() {
    return this.load().token;
  }
  saveToken(token) {
    this.save({ token });
  }
  clearToken() {
    const data = this.load();
    delete data.token;
    fs__namespace.mkdirSync(this.dir, { recursive: true, mode: 448 });
    fs__namespace.writeFileSync(this.filePath(), JSON.stringify(data, null, 2), { mode: 384 });
  }
}
class PlaudConfig {
  store;
  /**
   * @param storeOrDir Either a CredentialStore instance, or a string path
   *   to override the default ~/.plaud directory. Omitting the argument
   *   uses a FileCredentialStore at the default location.
   */
  constructor(storeOrDir) {
    if (storeOrDir === void 0) {
      this.store = new FileCredentialStore();
    } else if (typeof storeOrDir === "string") {
      this.store = new FileCredentialStore(storeOrDir);
    } else {
      this.store = storeOrDir;
    }
  }
  load() {
    const credentials = this.store.getCredentials();
    const token = this.store.getToken();
    const out = {};
    if (credentials) out.credentials = credentials;
    if (token) out.token = token;
    return out;
  }
  saveToken(token) {
    this.store.saveToken(token);
  }
  saveCredentials(credentials) {
    this.store.saveCredentials(credentials);
  }
  /**
   * Atomic-ish save of arbitrary subset of config (credentials, token).
   * Retained from the original API so callers (the CLI tests in particular)
   * keep working unchanged. New callers should prefer the typed
   * saveCredentials / saveToken methods.
   */
  save(data) {
    if (data.credentials) this.store.saveCredentials(data.credentials);
    if (data.token) this.store.saveToken(data.token);
  }
  getToken() {
    return this.store.getToken();
  }
  getCredentials() {
    return this.store.getCredentials();
  }
  clearCredentials() {
    this.store.clearCredentials();
  }
  clearToken() {
    this.store.clearToken();
  }
}
class PlaudNotAuthenticatedError extends Error {
  constructor() {
    super(
      "Plaud is not authenticated. Open Settings -> Sources and sign in to Plaud."
    );
    this.name = "PlaudNotAuthenticatedError";
  }
}
function connect(store) {
  const config = new PlaudConfig(store);
  const data = config.load();
  const hasToken = data.token !== void 0;
  const hasCredentials = data.credentials !== void 0;
  if (!hasToken && !hasCredentials) {
    throw new PlaudNotAuthenticatedError();
  }
  const region = data.credentials?.region ?? "us";
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, region);
  return { client, auth, config, region };
}
async function signInPlaud(store, credentials) {
  await store.saveCredentialsAsync(credentials);
  const config = new PlaudConfig(store);
  const auth = new PlaudAuth(config);
  await auth.login();
  return { email: credentials.email, region: credentials.region };
}
async function signOutPlaud(store) {
  await store.clearCredentialsAsync();
  store.clearToken();
}
function getPlaudAccountStatus(store) {
  const config = new PlaudConfig(store);
  const data = config.load();
  if (!data.credentials) {
    return { signedIn: false };
  }
  return {
    signedIn: true,
    email: data.credentials.email,
    region: data.credentials.region,
    tokenExpiresAt: data.token?.expiresAt ?? null
  };
}
const KEYCHAIN_SERVICE = "distill.plaud";
const PLAUD_DIR = path__namespace.join(os__namespace.homedir(), ".plaud");
const CONFIG_FILE = path__namespace.join(PLAUD_DIR, "config.json");
function readFile() {
  try {
    const raw = fs__namespace.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
function writeFile(data) {
  fs__namespace.mkdirSync(PLAUD_DIR, { recursive: true, mode: 448 });
  fs__namespace.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 384 });
}
class KeychainCredentialStore {
  /**
   * Read credentials. Email + region come from the file; password comes
   * from Keychain (with a fallback to the file's legacy password field
   * for installs that haven't been migrated yet).
   *
   * Returns undefined if no credentials are configured at all.
   *
   * Note: keytar's getPassword is async. The CredentialStore interface
   * is sync so we use the synchronous Atomics-based pattern... actually
   * no, we can't. The interface IS sync. This is a real impedance
   * mismatch worth confronting head-on.
   *
   * Resolution: we cache the password in memory after the first async
   * read, populated explicitly via prime() before the store is handed
   * to PlaudConfig. Callers in the Electron main process can `await`
   * prime() during app startup; from that point the sync getCredentials
   * works because the password is cached.
   */
  cachedPassword;
  cachedEmail;
  /**
   * Populate the in-memory password cache from Keychain. Must be called
   * once at app startup, after which getCredentials() works
   * synchronously. If the user has not yet signed in, prime() is a
   * no-op and getCredentials() returns undefined as expected.
   */
  async prime() {
    const file = readFile();
    if (!file.credentials) {
      this.cachedPassword = void 0;
      this.cachedEmail = void 0;
      return;
    }
    const email = file.credentials.email;
    this.cachedEmail = email;
    const fromKeychain = await keytar__namespace.getPassword(KEYCHAIN_SERVICE, email);
    if (fromKeychain) {
      this.cachedPassword = fromKeychain;
      return;
    }
    if (file.credentials.password) {
      this.cachedPassword = file.credentials.password;
      return;
    }
    this.cachedPassword = void 0;
  }
  getCredentials() {
    const file = readFile();
    if (!file.credentials || !this.cachedPassword) {
      return void 0;
    }
    if (this.cachedEmail !== file.credentials.email) {
      return void 0;
    }
    return {
      email: file.credentials.email,
      password: this.cachedPassword,
      region: file.credentials.region
    };
  }
  /**
   * Save credentials. Password goes to Keychain; email and region go
   * to the file. After this call, getCredentials() returns the new
   * values immediately (the in-memory cache is updated).
   *
   * keytar.setPassword is async, so this method is async too. The
   * sync method on the CredentialStore interface delegates to a
   * fire-and-forget setPassword; new code in the app should call
   * saveCredentialsAsync directly.
   */
  saveCredentials(credentials) {
    void this.saveCredentialsAsync(credentials);
  }
  /**
   * Async version of saveCredentials. Prefer this from app code so
   * Keychain write errors surface explicitly.
   */
  async saveCredentialsAsync(credentials) {
    await keytar__namespace.setPassword(KEYCHAIN_SERVICE, credentials.email, credentials.password);
    const file = readFile();
    file.credentials = {
      email: credentials.email,
      region: credentials.region
      // password intentionally omitted from new writes
    };
    writeFile(file);
    this.cachedEmail = credentials.email;
    this.cachedPassword = credentials.password;
  }
  clearCredentials() {
    void this.clearCredentialsAsync();
  }
  async clearCredentialsAsync() {
    const file = readFile();
    if (file.credentials) {
      try {
        await keytar__namespace.deletePassword(KEYCHAIN_SERVICE, file.credentials.email);
      } catch {
      }
      delete file.credentials;
      writeFile(file);
    }
    this.cachedEmail = void 0;
    this.cachedPassword = void 0;
  }
  getToken() {
    return readFile().token;
  }
  saveToken(token) {
    const file = readFile();
    file.token = token;
    writeFile(file);
  }
  clearToken() {
    const file = readFile();
    delete file.token;
    writeFile(file);
  }
}
async function migratePasswordToKeychain() {
  const file = readFile();
  if (!file.credentials || !file.credentials.password) {
    return "no-op";
  }
  const email = file.credentials.email;
  const keychainCopy = await keytar__namespace.getPassword(KEYCHAIN_SERVICE, email);
  if (!keychainCopy) {
    return "kept-as-fallback";
  }
  if (keychainCopy !== file.credentials.password) ;
  delete file.credentials.password;
  writeFile(file);
  return "migrated";
}
const INITIAL_POLL_KEY = "hasCompletedInitialPoll";
class Poller {
  constructor(opts) {
    this.opts = opts;
  }
  timer = null;
  consecutiveFailures = 0;
  inFlight = false;
  lastResult = null;
  started = false;
  start() {
    if (this.started) return;
    this.started = true;
    void this.tick();
    this.scheduleNext();
  }
  stop() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  getLastResult() {
    return this.lastResult;
  }
  /** Manually trigger a poll now (from the tray "Sync now" item). */
  async syncNow() {
    return this.tick();
  }
  scheduleNext() {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    let intervalMs = this.opts.intervalMinutes * 6e4;
    if (this.consecutiveFailures >= 3) intervalMs *= 2;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, intervalMs);
  }
  async tick() {
    if (this.inFlight) {
      return this.lastResult ?? { kind: "ok", newCount: 0, totalSeen: 0, at: Date.now() };
    }
    this.inFlight = true;
    try {
      if (this.opts.shouldPause()) {
        const result2 = { kind: "skipped-paused", at: Date.now() };
        this.lastResult = result2;
        this.opts.onPoll(result2, []);
        return result2;
      }
      const all = await this.opts.client.listRecordings();
      let processedElsewhere = /* @__PURE__ */ new Map();
      if (this.opts.loadProcessedElsewhere) {
        try {
          processedElsewhere = await this.opts.loadProcessedElsewhere();
          if (processedElsewhere.size > 0) {
            this.opts.logger.info(
              { count: processedElsewhere.size },
              "cross-machine completion lookup ready"
            );
          }
        } catch (e) {
          this.opts.logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            "cross-machine completion lookup failed; proceeding without it"
          );
        }
      }
      const isInitialPoll = this.opts.state.getAppState(INITIAL_POLL_KEY) !== "true";
      const initialStatus = isInitialPoll ? "skipped" : "inbox";
      const fresh = [];
      let processedExternallyCount = 0;
      for (const r of all) {
        if (this.opts.state.recordingExists(r.id)) continue;
        const durationSeconds = typeof r.duration === "number" ? Math.round(r.duration / 1e3) : null;
        const elsewhere = initialStatus === "inbox" ? processedElsewhere.get(r.id) : void 0;
        const rowStatus = elsewhere ? "complete" : initialStatus;
        if (elsewhere) processedExternallyCount += 1;
        this.opts.state.insertRecording({
          id: r.id,
          filename: r.filename,
          duration_seconds: durationSeconds,
          start_time: r.start_time,
          filesize_bytes: r.filesize,
          synced_at: Date.now(),
          status: rowStatus,
          client_id: null,
          meeting_type_id: null,
          audio_path: null,
          transcript_text: null,
          summary_text: null,
          markdown_path: elsewhere ? elsewhere.markdownPath : null,
          error: null,
          is_auth_error: 0,
          last_step: null,
          prompt_snapshot: null,
          model_snapshot: elsewhere ? elsewhere.modelSnapshot : null,
          whisper_snapshot: elsewhere ? elsewhere.whisperSnapshot : null,
          vocabulary_sources: null,
          vocabulary_rules_applied: null,
          source: "plaud",
          html_path: null,
          apple_note_id: null,
          markdown_written_at: elsewhere ? elsewhere.writtenAtMs : null,
          html_written_at: null,
          apple_note_written_at: null,
          truncation_warning: 0,
          estimated_input_tokens: null,
          context_window_at_submit: null,
          processed_externally: elsewhere ? 1 : 0
        });
        if (rowStatus === "inbox") fresh.push(r);
      }
      if (isInitialPoll) {
        this.opts.state.setAppState(INITIAL_POLL_KEY, "true");
        this.opts.logger.info(
          { totalSeen: all.length, markedSkipped: all.length },
          "initial poll complete — existing recordings marked as skipped"
        );
      } else if (processedExternallyCount > 0) {
        this.opts.logger.info(
          { count: processedExternallyCount },
          "recordings adopted from another machine’s outputs"
        );
      }
      const result = {
        kind: "ok",
        newCount: fresh.length,
        totalSeen: all.length,
        at: Date.now()
      };
      this.lastResult = result;
      this.consecutiveFailures = 0;
      this.opts.logger.info(
        { totalSeen: all.length, newCount: fresh.length },
        "poll ok"
      );
      this.opts.onPoll(result, fresh);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const result = { kind: "error", message, at: Date.now() };
      this.lastResult = result;
      this.consecutiveFailures++;
      this.opts.logger.warn(
        { err: message, consecutiveFailures: this.consecutiveFailures },
        "poll failed"
      );
      this.opts.onPoll(result, []);
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}
async function loadProcessedElsewhereIds(baseDir) {
  const result = /* @__PURE__ */ new Map();
  let topLevel;
  try {
    const entries = await promises.readdir(baseDir, { withFileTypes: true });
    topLevel = entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return result;
  }
  for (const entry of topLevel) {
    if (entry.isDirectory) {
      await scanDirectoryInto(node_path.join(baseDir, entry.name), result);
    } else if (entry.name.toLowerCase().endsWith(".md")) {
      await tryAddFile(node_path.join(baseDir, entry.name), result);
    }
  }
  return result;
}
async function scanDirectoryInto(dir, result) {
  let entries;
  try {
    entries = await promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    await tryAddFile(node_path.join(dir, name), result);
  }
}
async function tryAddFile(filePath, result) {
  let frontmatter;
  let mtimeMs;
  try {
    const buf = await promises.readFile(filePath);
    const head = buf.subarray(0, 4096).toString("utf8");
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return;
    frontmatter = match[1];
    const stats = await promises.stat(filePath);
    mtimeMs = stats.mtimeMs;
  } catch {
    return;
  }
  const parsed = parseSimpleFrontmatter(frontmatter);
  const recordingId = parsed.recording_id;
  if (!recordingId) return;
  const existing = result.get(recordingId);
  if (existing && existing.writtenAtMs >= mtimeMs) return;
  result.set(recordingId, {
    markdownPath: filePath,
    writtenAtMs: mtimeMs,
    modelSnapshot: parsed.model ?? null,
    whisperSnapshot: parsed.whisper_model ?? null
  });
}
function parseSimpleFrontmatter(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length === 0) continue;
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      try {
        value = JSON.parse(value.replace(/^'|'$/g, '"'));
      } catch {
      }
    }
    out[key] = value;
  }
  return out;
}
function notify(opts) {
  if (!electron.Notification.isSupported()) return;
  const n = new electron.Notification({
    title: opts.title,
    body: opts.body,
    silent: opts.silent ?? false
  });
  if (opts.onClick) n.on("click", opts.onClick);
  n.show();
}
const KEEPALIVE_PRESETS = [
  { value: "0", label: "Off (unload immediately)" },
  { value: "5m", label: "5 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" }
];
const WHISPER_MODEL_PRESETS = [
  { value: "mlx-community/whisper-large-v3-mlx", label: "Large v3 (best quality, slowest)" },
  { value: "mlx-community/whisper-medium-mlx", label: "Medium" },
  { value: "mlx-community/whisper-small-mlx", label: "Small" },
  { value: "mlx-community/whisper-base-mlx", label: "Base" },
  { value: "mlx-community/whisper-tiny-mlx", label: "Tiny (fastest, lowest quality)" }
];
const Channels = {
  InboxList: "inbox.list",
  InboxSkip: "inbox.skip",
  InboxRevealInFinder: "inbox.revealInFinder",
  PipelineCancel: "pipeline.cancel",
  PipelineRetry: "pipeline.retry",
  TagSave: "tag.save",
  TagOpenSheet: "tag.open-sheet",
  ClientsList: "clients.list",
  ClientsAdd: "clients.add",
  MeetingTypesList: "meetingTypes.list",
  MeetingTypesAdd: "meetingTypes.add",
  MeetingTypesDelete: "meetingTypes.delete",
  LocalImportPath: "localImport.path",
  LocalImportPickFiles: "localImport.pickFiles",
  PushLocalImportProgress: "push:local-import-progress",
  SettingsLoad: "settings.load",
  SettingsSaveOutputs: "settings.saveOutputs",
  SettingsSavePrompt: "settings.savePrompt",
  SettingsRevertPromptToBuiltin: "settings.revertPromptToBuiltin",
  SettingsImportPrompts: "settings.importPrompts",
  SettingsLoadVocabulary: "settings.loadVocabulary",
  SettingsSaveVocabulary: "settings.saveVocabulary",
  SettingsImportVocabulary: "settings.importVocabulary",
  SettingsExportVocabulary: "settings.exportVocabulary",
  SettingsSaveGeneral: "settings.saveGeneral",
  SettingsSavePerformance: "settings.savePerformance",
  SettingsListOllamaModels: "settings.listOllamaModels",
  SettingsBrowseFolder: "settings.browseFolder",
  SourcesPlaudSignIn: "sources.plaudSignIn",
  SourcesPlaudSignOut: "sources.plaudSignOut",
  SourcesPlaudStatus: "sources.plaudStatus",
  AppOpenSettings: "app.openSettings",
  AppGetTipJarStatus: "app.getTipJarStatus",
  AppDismissTipJarBanner: "app.dismissTipJarBanner",
  AppOpenTipJar: "app.openTipJar",
  SetupGetStatus: "setup.getStatus",
  SetupStart: "setup.start",
  SetupQuit: "setup.quit",
  PushSetupProgress: "push:setup-progress",
  PushInboxChanged: "push:inbox-changed",
  PushFocusRecording: "push:focus-recording"
};
let ctx = null;
let inboxWin = null;
let tagWin = null;
let settingsWin = null;
let setupWin = null;
let pendingFocusId = null;
function configureWindows(c) {
  ctx = c;
}
function openInbox(trayBounds, focusRecordingId) {
  if (!ctx) throw new Error("configureWindows must be called first");
  if (focusRecordingId) pendingFocusId = focusRecordingId;
  if (inboxWin && !inboxWin.isDestroyed()) {
    positionUnderTray(inboxWin, trayBounds);
    inboxWin.show();
    inboxWin.focus();
    if (pendingFocusId) {
      inboxWin.webContents.send(Channels.PushFocusRecording, pendingFocusId);
      pendingFocusId = null;
    }
    return;
  }
  inboxWin = new electron.BrowserWindow({
    width: 480,
    height: 640,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    fullscreenable: false,
    title: "distill — Inbox",
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
      // preload needs Node for ipcRenderer types
    }
  });
  positionUnderTray(inboxWin, trayBounds);
  void loadRendererEntry(inboxWin, "inbox");
  inboxWin.once("ready-to-show", () => {
    inboxWin?.show();
    if (pendingFocusId) {
      inboxWin?.webContents.send(Channels.PushFocusRecording, pendingFocusId);
      pendingFocusId = null;
    }
  });
  inboxWin.on("closed", () => {
    inboxWin = null;
  });
}
function openTagSheet(recordingId) {
  if (!ctx) throw new Error("configureWindows must be called first");
  if (tagWin && !tagWin.isDestroyed()) {
    tagWin.close();
    tagWin = null;
  }
  tagWin = new electron.BrowserWindow({
    width: 420,
    height: 420,
    show: false,
    frame: false,
    resizable: false,
    // Not a child of the inbox — on macOS, child windows of frameless
    // parents inherit weird behaviour (off-screen placement, unexpected
    // close-on-parent-blur). Keep the tag sheet fully independent.
    skipTaskbar: true,
    fullscreenable: false,
    title: "distill — Tag recording",
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: [`--recording-id=${recordingId}`]
    }
  });
  positionTagSheet(tagWin);
  void loadRendererEntry(tagWin, "tag");
  tagWin.once("ready-to-show", () => {
    tagWin?.show();
    tagWin?.focus();
  });
  tagWin.on("closed", () => {
    tagWin = null;
  });
}
function closeAll() {
  if (inboxWin && !inboxWin.isDestroyed()) inboxWin.close();
  if (tagWin && !tagWin.isDestroyed()) tagWin.close();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
  if (setupWin && !setupWin.isDestroyed()) setupWin.close();
  inboxWin = null;
  tagWin = null;
  settingsWin = null;
  setupWin = null;
}
function openSettings(opts) {
  if (!ctx) throw new Error("configureWindows must be called first");
  const hash = opts?.initialTab ? `#${opts.initialTab}` : "";
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (hash) {
      const current = settingsWin.webContents.getURL();
      const base = current.split("#")[0];
      void settingsWin.loadURL(`${base}${hash}`);
    }
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new electron.BrowserWindow({
    width: 720,
    height: 720,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "distill — Settings",
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  centreOnCursorDisplay(settingsWin);
  void loadRendererEntry(settingsWin, "settings", hash);
  settingsWin.once("ready-to-show", () => {
    settingsWin?.show();
    settingsWin?.focus();
  });
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}
function openSetup() {
  if (!ctx) throw new Error("configureWindows must be called first");
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.show();
    setupWin.focus();
    return setupWin;
  }
  setupWin = new electron.BrowserWindow({
    width: 640,
    height: 520,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "distill — Setup",
    webPreferences: {
      preload: ctx.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  centreOnCursorDisplay(setupWin);
  void loadRendererEntry(setupWin, "setup");
  setupWin.once("ready-to-show", () => {
    setupWin?.show();
    setupWin?.focus();
  });
  setupWin.on("closed", () => {
    setupWin = null;
  });
  return setupWin;
}
function centreOnCursorDisplay(win) {
  const bounds = win.getBounds();
  const display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}
async function loadRendererEntry(win, entry, hash = "") {
  if (!ctx) return;
  if (ctx.rendererDevUrl) {
    await win.loadURL(`${ctx.rendererDevUrl}/${entry}/index.html${hash}`);
  } else {
    if (hash) {
      const filePath = node_path.join(ctx.rendererDistDir, entry, "index.html");
      await win.loadFile(filePath, { hash: hash.replace(/^#/, "") });
    } else {
      await win.loadFile(node_path.join(ctx.rendererDistDir, entry, "index.html"));
    }
  }
}
function positionUnderTray(win, trayBounds) {
  const bounds = win.getBounds();
  const display = trayBounds ? electron.screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y }) : electron.screen.getPrimaryDisplay();
  if (trayBounds) {
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - bounds.width / 2);
    const y = Math.round(trayBounds.y + trayBounds.height + 4);
    const workArea = display.workArea;
    if (x + bounds.width > workArea.x + workArea.width) {
      x = workArea.x + workArea.width - bounds.width - 8;
    }
    if (x < workArea.x + 8) x = workArea.x + 8;
    win.setPosition(x, y, false);
  } else {
    centreOnCurrentDisplay(win);
  }
}
function centreOnCurrentDisplay(win) {
  const bounds = win.getBounds();
  const display = electron.screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}
function positionTagSheet(win) {
  const bounds = win.getBounds();
  let display;
  if (inboxWin && !inboxWin.isDestroyed()) {
    const ib = inboxWin.getBounds();
    display = electron.screen.getDisplayNearestPoint({
      x: ib.x + Math.round(ib.width / 2),
      y: ib.y + Math.round(ib.height / 2)
    });
  } else {
    display = electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint());
  }
  const workArea = display.workArea;
  const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2);
  const y = Math.round(workArea.y + (workArea.height - bounds.height) / 3);
  win.setPosition(x, y, false);
}
const AUDIO_EXTS = /* @__PURE__ */ new Set([".mp3", ".m4a", ".wav", ".aac", ".ogg", ".flac", ".opus"]);
const VIDEO_EXTS = /* @__PURE__ */ new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);
class LocalImportError extends Error {
  constructor(userMessage, cause) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = "LocalImportError";
    if (cause instanceof Error) this.stack = `${this.stack}
Caused by: ${cause.stack}`;
  }
}
function classifyPath(path2) {
  const ext = node_path.extname(path2).toLowerCase();
  if (AUDIO_EXTS.has(ext)) return "audio-passthrough";
  if (VIDEO_EXTS.has(ext)) return "video-extract-audio";
  return "unsupported";
}
async function importLocalFile(srcPath, deps) {
  if (!node_fs.existsSync(srcPath)) {
    throw new LocalImportError(`File not found: ${srcPath}`);
  }
  const kind = classifyPath(srcPath);
  if (kind === "unsupported") {
    throw new LocalImportError(
      `Unsupported file type: ${node_path.extname(srcPath) || "(no extension)"}. Accepted formats: ${[...AUDIO_EXTS, ...VIDEO_EXTS].sort().join(", ")}.`
    );
  }
  const dir = audioDir();
  node_fs.mkdirSync(dir, { recursive: true });
  const id = `local-${node_crypto.randomUUID().slice(0, 12)}`;
  const originalName = node_path.basename(srcPath);
  const dest = node_path.join(dir, `${id}.mp3`);
  const emit = (phase, percent) => {
    if (!deps.onProgress) return;
    try {
      deps.onProgress({ sourcePath: srcPath, phase, percent });
    } catch (e) {
      deps.logger.warn({ err: String(e) }, "progress callback threw — ignoring");
    }
  };
  emit("probe", null);
  const sourceDuration = probeDurationSeconds(srcPath);
  if (kind === "audio-passthrough") {
    deps.logger.info({ src: srcPath, dest, originalName }, "copying local audio");
    await streamingCopyWithProgress(srcPath, dest, (percent) => emit("copy", percent));
  } else {
    await extractAudioFromVideo(
      srcPath,
      dest,
      sourceDuration,
      deps.logger,
      (percent) => emit("extract", percent)
    );
  }
  const size = node_fs.statSync(dest).size;
  if (size === 0) {
    node_fs.unlinkSync(dest);
    throw new LocalImportError("Resulting audio file is empty.");
  }
  emit("finalise", null);
  const durationSeconds = kind === "audio-passthrough" && sourceDuration !== null ? sourceDuration : probeDurationSeconds(dest);
  const now = Date.now();
  deps.state.insertRecording({
    id,
    filename: originalName,
    duration_seconds: durationSeconds,
    start_time: fileMtime(srcPath) ?? now,
    filesize_bytes: size,
    synced_at: now,
    status: "inbox",
    client_id: null,
    meeting_type_id: null,
    audio_path: dest,
    transcript_text: null,
    summary_text: null,
    markdown_path: null,
    error: null,
    is_auth_error: 0,
    last_step: null,
    prompt_snapshot: null,
    model_snapshot: null,
    whisper_snapshot: null,
    vocabulary_sources: null,
    vocabulary_rules_applied: null,
    source: "local",
    html_path: null,
    apple_note_id: null,
    markdown_written_at: null,
    html_written_at: null,
    apple_note_written_at: null,
    truncation_warning: 0,
    estimated_input_tokens: null,
    context_window_at_submit: null,
    processed_externally: 0
  });
  deps.logger.info(
    { id, kind, originalName, audioPath: dest, durationSeconds, bytes: size },
    "local file imported"
  );
  return { recordingId: id, kind, audioPath: dest, durationSeconds };
}
async function streamingCopyWithProgress(src, dest, onPercent) {
  const totalBytes = node_fs.statSync(src).size;
  if (totalBytes === 0) {
    throw new LocalImportError("Source file is empty.");
  }
  let bytesCopied = 0;
  let lastEmitMs = 0;
  return new Promise((resolve, reject) => {
    const reader = node_fs.createReadStream(src);
    const writer = node_fs.createWriteStream(dest);
    reader.on("data", (chunk) => {
      bytesCopied += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      const now = Date.now();
      if (now - lastEmitMs >= 200) {
        lastEmitMs = now;
        const percent = Math.min(99, Math.floor(bytesCopied / totalBytes * 100));
        onPercent(percent);
      }
    });
    reader.on("error", (e) => {
      try {
        if (node_fs.existsSync(dest)) node_fs.unlinkSync(dest);
      } catch {
      }
      reject(new LocalImportError(`Could not read source: ${e.message}`, e));
    });
    writer.on("error", (e) => {
      try {
        if (node_fs.existsSync(dest)) node_fs.unlinkSync(dest);
      } catch {
      }
      reject(new LocalImportError(`Could not write to audio cache: ${e.message}`, e));
    });
    writer.on("close", () => {
      onPercent(100);
      resolve();
    });
    reader.pipe(writer);
  });
}
async function extractAudioFromVideo(src, dest, totalDurationSeconds, logger2, onPercent) {
  if (!isOnPath("ffmpeg")) {
    throw new LocalImportError(
      "ffmpeg is not installed, so video files cannot be imported. Install it with: brew install ffmpeg. Audio files (.mp3, .m4a, .wav) can still be imported without ffmpeg."
    );
  }
  logger2.info({ src, dest, totalDurationSeconds }, "extracting audio from video via ffmpeg");
  const args = [
    "-nostdin",
    "-i",
    src,
    "-vn",
    "-acodec",
    "mp3",
    "-ab",
    "128k",
    "-ar",
    "16000",
    "-y",
    dest
  ];
  const proc = node_child_process.spawn("ffmpeg", args);
  let stderr = "";
  let lastEmitMs = 0;
  onPercent(totalDurationSeconds !== null ? 0 : null);
  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderr += text;
    if (totalDurationSeconds === null) return;
    const matches = text.matchAll(/time=(\d+):(\d{2}):(\d{2})\.(\d{1,3})/g);
    let lastSeconds = null;
    for (const m of matches) {
      const h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const s = parseInt(m[3], 10);
      const fracStr = m[4];
      const frac = parseFloat(`0.${fracStr}`);
      if (Number.isFinite(h) && Number.isFinite(min) && Number.isFinite(s)) {
        lastSeconds = h * 3600 + min * 60 + s + frac;
      }
    }
    if (lastSeconds === null) return;
    const now = Date.now();
    if (now - lastEmitMs < 200) return;
    lastEmitMs = now;
    const percent = Math.min(99, Math.floor(lastSeconds / totalDurationSeconds * 100));
    onPercent(percent);
  });
  const exitCode = await new Promise((resolve, reject) => {
    proc.once("error", (err) => reject(err));
    proc.once("close", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    if (node_fs.existsSync(dest)) {
      try {
        node_fs.unlinkSync(dest);
      } catch {
      }
    }
    const tail = stderr.split("\n").filter((l) => l.trim()).slice(-8).join("\n");
    throw new LocalImportError(
      `ffmpeg failed (exit ${exitCode}):
${tail || stderr.slice(-500)}`
    );
  }
  onPercent(100);
}
function probeDurationSeconds(path2) {
  if (!isOnPath("ffprobe")) return null;
  const result = node_child_process.spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path2
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) return null;
  const parsed = parseFloat(result.stdout.trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
function isOnPath(binary) {
  const result = node_child_process.spawnSync("which", [binary], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim().length > 0;
}
function fileMtime(path2) {
  try {
    return node_fs.statSync(path2).mtimeMs;
  } catch {
    return null;
  }
}
function parseVocabularyMarkdownTables(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const next = lines[i + 1] ?? "";
    if (looksLikeTableRow(line) && looksLikeSeparator(next)) {
      const headerCells = splitTableRow(line);
      const headerMap = recogniseHeader(headerCells);
      if (headerMap === null) {
        i += 2;
        while (i < lines.length && looksLikeTableRow(lines[i] ?? "")) i++;
        continue;
      }
      i += 2;
      while (i < lines.length && looksLikeTableRow(lines[i] ?? "")) {
        const cells = splitTableRow(lines[i] ?? "");
        const entry = rowToReplacement(cells, headerMap);
        if (entry) out.push(entry);
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}
function looksLikeTableRow(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return trimmed.includes("|");
}
function looksLikeSeparator(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.includes("-")) return false;
  for (const ch of trimmed) {
    if (ch !== "-" && ch !== "|" && ch !== ":" && ch !== " ") return false;
  }
  return true;
}
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}
function recogniseHeader(cells) {
  let heardAs = -1;
  let shouldBe = -1;
  let context = null;
  for (let i = 0; i < cells.length; i++) {
    const normalised = cells[i].toLowerCase().trim();
    if (heardAs === -1 && normalised === "heard as") heardAs = i;
    else if (shouldBe === -1 && normalised === "should be") shouldBe = i;
    else if (context === null && (normalised === "context cue" || normalised === "context" || normalised === "context cues")) {
      context = i;
    }
  }
  if (heardAs === -1 || shouldBe === -1) return null;
  return { heardAs, shouldBe, context };
}
function rowToReplacement(cells, header) {
  const from = (cells[header.heardAs] ?? "").trim();
  const to = (cells[header.shouldBe] ?? "").trim();
  if (from.length === 0 || to.length === 0) return null;
  let requiresContext;
  if (header.context !== null) {
    const raw = (cells[header.context] ?? "").trim();
    if (raw.length > 0) {
      const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
      if (parts.length > 0) requiresContext = parts;
    }
  }
  return {
    from,
    to,
    ...requiresContext ? { requiresContext } : {}
  };
}
const venvDir = () => node_path.join(appSupportDir(), "venv");
const venvPython = () => node_path.join(venvDir(), "bin", "python");
const venvPip = () => node_path.join(venvDir(), "bin", "pip");
function detectVenv() {
  const py = venvPython();
  if (!node_fs.existsSync(py)) {
    return node_fs.existsSync(venvDir()) ? { kind: "broken", reason: `python binary missing at ${py}` } : { kind: "missing" };
  }
  const versionResult = node_child_process.spawnSync(py, ["--version"], {
    encoding: "utf-8",
    timeout: 5e3
  });
  if (versionResult.error || versionResult.status !== 0) {
    return {
      kind: "broken",
      reason: versionResult.error?.message ?? `python --version exited ${versionResult.status}: ${versionResult.stderr}`
    };
  }
  const versionLine = (versionResult.stdout || versionResult.stderr).trim() || "unknown";
  if (!/^Python 3\.11\./.test(versionLine)) {
    return {
      kind: "wrong-version",
      pythonPath: py,
      foundVersion: versionLine
    };
  }
  const importResult = node_child_process.spawnSync(py, ["-c", "import mlx_whisper"], {
    encoding: "utf-8",
    timeout: 1e4
  });
  if (importResult.status !== 0) {
    return { kind: "incomplete", pythonPath: py, pythonVersion: versionLine };
  }
  return { kind: "ready", pythonPath: py, pythonVersion: versionLine };
}
function detectSystemPython() {
  const candidates = [
    "/opt/homebrew/bin/python3.11",
    // Apple Silicon Homebrew
    "/usr/local/bin/python3.11",
    // Intel Homebrew or python.org installer
    // PATH fallbacks. Won't help much in the packaged-app context
    // but cheap to try and useful in dev.
    "python3.11",
    "python3"
  ];
  for (const candidate of candidates) {
    const result = node_child_process.spawnSync(candidate, ["--version"], {
      encoding: "utf-8",
      timeout: 3e3
    });
    if (result.error || result.status !== 0) continue;
    const versionLine = (result.stdout || result.stderr).trim() || "";
    if (/^Python 3\.11\./.test(versionLine)) {
      return { kind: "found", path: candidate, version: versionLine };
    }
  }
  return { kind: "not-found", triedPaths: candidates };
}
function getInstallationStatus(devVenvPath) {
  const venvStatus = detectVenv();
  if (venvStatus.kind === "ready") {
    return {
      kind: "ready",
      pythonPath: venvStatus.pythonPath,
      source: "user-venv"
    };
  }
  if (devVenvPath !== null && node_fs.existsSync(devVenvPath)) {
    return { kind: "ready", pythonPath: devVenvPath, source: "dev-venv" };
  }
  const systemPython = detectSystemPython();
  if (systemPython.kind === "not-found") {
    return {
      kind: "python-missing",
      venvStatus,
      triedPaths: systemPython.triedPaths
    };
  }
  return { kind: "needs-setup", venvStatus, systemPython: systemPython.path };
}
function resolveBundledRoot() {
  if (electron.app.isPackaged) {
    return process.resourcesPath;
  }
  return electron.app.getAppPath();
}
let bundledRootCache = null;
function bundledRoot() {
  if (bundledRootCache === null) bundledRootCache = resolveBundledRoot();
  return bundledRootCache;
}
const bundledResourcesDir = () => node_path.join(bundledRoot(), "resources");
const bundledPythonDir = () => node_path.join(bundledRoot(), "python");
const bundledTranscribeScript = () => node_path.join(bundledRoot(), "python", "transcribe.py");
const bundledRequirementsFile = () => node_path.join(bundledRoot(), "python", "requirements.txt");
async function installVenv(opts) {
  const { systemPython, signal, onProgress, logger: logger2 } = opts;
  try {
    node_fs.mkdirSync(node_path.dirname(venvDir()), { recursive: true });
  } catch (e) {
    return {
      kind: "failed",
      phase: "creating-venv",
      message: `Could not create parent directory for venv: ${String(e)}`
    };
  }
  const venvAlreadyExists = node_fs.existsSync(venvPython());
  if (!venvAlreadyExists) {
    onProgress({ phase: "creating-venv" });
    logger2?.info({ systemPython, venvDir: venvDir() }, "creating venv");
    const venvResult = await spawnLineByLine(
      systemPython,
      ["-m", "venv", venvDir()],
      { signal, onProgress, phase: "creating-venv" }
    );
    if (venvResult.kind === "cancelled") return { kind: "cancelled" };
    if (venvResult.kind === "failed") {
      return {
        kind: "failed",
        phase: "creating-venv",
        message: venvResult.message
      };
    }
  } else {
    logger2?.info("venv already exists, skipping creation");
  }
  onProgress({ phase: "installing-packages" });
  logger2?.info(
    { pip: venvPip(), reqs: bundledRequirementsFile() },
    "installing packages"
  );
  const pipResult = await spawnLineByLine(
    venvPip(),
    [
      "install",
      "--no-input",
      "--disable-pip-version-check",
      "-r",
      bundledRequirementsFile()
    ],
    { signal, onProgress, phase: "installing-packages" }
  );
  if (pipResult.kind === "cancelled") return { kind: "cancelled" };
  if (pipResult.kind === "failed") {
    return {
      kind: "failed",
      phase: "installing-packages",
      message: pipResult.message
    };
  }
  onProgress({ phase: "verifying" });
  logger2?.info("verifying mlx_whisper import");
  const verifyResult = await spawnLineByLine(
    venvPython(),
    ["-c", 'import mlx_whisper; print("ok")'],
    { signal, onProgress, phase: "verifying" }
  );
  if (verifyResult.kind === "cancelled") return { kind: "cancelled" };
  if (verifyResult.kind === "failed") {
    return {
      kind: "failed",
      phase: "verifying",
      message: "Install completed but `import mlx_whisper` still failed. " + verifyResult.message
    };
  }
  return { kind: "success", pythonPath: venvPython() };
}
async function spawnLineByLine(command, args, opts) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = node_child_process.spawn(command, args, { signal: opts.signal });
    } catch (e) {
      resolve({
        kind: "failed",
        message: `Could not spawn ${command}: ${String(e)}`
      });
      return;
    }
    let stdoutBuf = "";
    let stderrBuf = "";
    const stderrTail = [];
    const stderrTailMax = 50;
    const flushLine = (stream, text) => {
      const trimmed = text.replace(/\r/g, "");
      if (trimmed.length === 0) return;
      opts.onProgress({
        phase: opts.phase,
        log: { stream, text: trimmed }
      });
      if (stream === "stderr") {
        stderrTail.push(trimmed);
        if (stderrTail.length > stderrTailMax) stderrTail.shift();
      }
    };
    const handleChunk = (stream, buf) => {
      const text = buf.toString("utf8");
      let bufRef = stream === "stdout" ? stdoutBuf : stderrBuf;
      bufRef += text;
      let nl = bufRef.indexOf("\n");
      while (nl !== -1) {
        flushLine(stream, bufRef.slice(0, nl));
        bufRef = bufRef.slice(nl + 1);
        nl = bufRef.indexOf("\n");
      }
      if (stream === "stdout") stdoutBuf = bufRef;
      else stderrBuf = bufRef;
    };
    proc.stdout?.on("data", (chunk) => handleChunk("stdout", chunk));
    proc.stderr?.on("data", (chunk) => handleChunk("stderr", chunk));
    proc.once("error", (err) => {
      if (err.name === "AbortError") {
        resolve({ kind: "cancelled" });
      } else {
        resolve({ kind: "failed", message: err.message });
      }
    });
    proc.once("close", (code) => {
      if (stdoutBuf.length > 0) flushLine("stdout", stdoutBuf);
      if (stderrBuf.length > 0) flushLine("stderr", stderrBuf);
      if (opts.signal?.aborted) {
        resolve({ kind: "cancelled" });
        return;
      }
      if (code === 0) {
        resolve({ kind: "ok" });
      } else {
        resolve({
          kind: "failed",
          message: `Process exited with code ${code}. Last stderr lines: ${stderrTail.join(" | ").slice(-1500)}`
        });
      }
    });
  });
}
const WHISPER_PROMPT_CHAR_LIMIT = 800;
function loadVocabulary(vocabularyDir, clientId) {
  const sources = [];
  const hints = [];
  const replacements = [];
  const files = ["global.json", "organisation.json", "industry.json"];
  if (clientId) files.push(`${clientId}.json`);
  for (const filename of files) {
    const path2 = node_path.join(vocabularyDir, filename);
    if (!node_fs.existsSync(path2)) continue;
    try {
      const data = JSON.parse(node_fs.readFileSync(path2, "utf-8"));
      if (data.whisperHints) hints.push(...data.whisperHints);
      if (data.replacements) replacements.push(...data.replacements);
      sources.push(filename);
    } catch (e) {
      throw new Error(
        `Invalid vocabulary file ${path2}: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  const uniqueHints = Array.from(new Set(hints));
  const whisperPrompt = buildWhisperPrompt(uniqueHints);
  return { whisperPrompt, replacements, sources };
}
function buildWhisperPrompt(hints) {
  if (hints.length === 0) return "";
  const trailer = ". This is a business meeting.";
  const hintList = hints.join(", ");
  const full = `${hintList}${trailer}`;
  if (full.length <= WHISPER_PROMPT_CHAR_LIMIT) return full;
  const budget = WHISPER_PROMPT_CHAR_LIMIT - trailer.length;
  const kept = [];
  let used = 0;
  for (const h of hints) {
    const cost = h.length + 2;
    if (used + cost > budget) break;
    kept.push(h);
    used += cost;
  }
  if (kept.length === 0) {
    return hints[0].slice(0, WHISPER_PROMPT_CHAR_LIMIT);
  }
  const list = kept.join(", ");
  if (list.length + trailer.length <= WHISPER_PROMPT_CHAR_LIMIT) {
    return `${list}${trailer}`;
  }
  return list;
}
function readVocabularyFile(vocabularyDir, scopeId) {
  const path2 = node_path.join(vocabularyDir, `${scopeId}.json`);
  if (!node_fs.existsSync(path2)) {
    return { $version: 1, whisperHints: [], replacements: [] };
  }
  try {
    return JSON.parse(node_fs.readFileSync(path2, "utf-8"));
  } catch (e) {
    throw new Error(
      `Invalid vocabulary file ${path2}: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
function writeVocabularyFile(vocabularyDir, scopeId, file) {
  node_fs.mkdirSync(vocabularyDir, { recursive: true });
  const path2 = node_path.join(vocabularyDir, `${scopeId}.json`);
  const serialised = JSON.stringify(file, null, 2) + "\n";
  node_fs.writeFileSync(path2, serialised, "utf-8");
}
const BUILTIN_SCOPE_IDS = ["global", "organisation", "industry"];
function isBuiltinScopeId(scopeId) {
  return BUILTIN_SCOPE_IDS.includes(scopeId);
}
function migrateScopeRenames(userDir, logger2) {
  const renamed = [];
  const deletedDuplicates = [];
  if (!node_fs.existsSync(userDir)) {
    return { renamed, deletedDuplicates };
  }
  const renames = [
    ["teradata.json", "organisation.json"],
    ["ai.json", "industry.json"]
  ];
  for (const [oldName, newName] of renames) {
    const oldPath = node_path.join(userDir, oldName);
    const newPath = node_path.join(userDir, newName);
    if (!node_fs.existsSync(oldPath)) continue;
    if (node_fs.existsSync(newPath)) {
      try {
        node_fs.unlinkSync(oldPath);
        deletedDuplicates.push(oldName);
        logger2?.warn(
          { oldName, newName, userDir },
          "vocabulary migration: both old and new scope files existed; deleted old, kept new"
        );
      } catch (e) {
      }
      continue;
    }
    try {
      node_fs.renameSync(oldPath, newPath);
      renamed.push(`${oldName} -> ${newName}`);
    } catch (e) {
    }
  }
  return { renamed, deletedDuplicates };
}
function migrateVocabularyToUserDir(bundledDir, userDir, logger2) {
  const copied = [];
  const skipped = [];
  if (!node_fs.existsSync(bundledDir)) {
    return { copied, skipped };
  }
  try {
    node_fs.mkdirSync(userDir, { recursive: true });
  } catch (e) {
    return { copied, skipped };
  }
  let entries;
  try {
    entries = node_fs.readdirSync(bundledDir).filter(
      (f) => f.endsWith(".json") && !f.startsWith(".")
    );
  } catch (e) {
    return { copied, skipped };
  }
  for (const filename of entries) {
    const src = node_path.join(bundledDir, filename);
    const dst = node_path.join(userDir, filename);
    if (node_fs.existsSync(dst)) {
      skipped.push(filename);
      continue;
    }
    try {
      node_fs.copyFileSync(src, dst);
      copied.push(filename);
    } catch (e) {
    }
  }
  return { copied, skipped };
}
function countVocabularyTerms(file) {
  return (file.whisperHints?.length ?? 0) + (file.replacements?.length ?? 0);
}
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s) {
  return s.replace(REGEX_METACHARS, "\\$&");
}
function applyReplacements(transcript, rules) {
  if (!transcript || rules.length === 0) return { text: transcript, applied: 0 };
  const transcriptLower = transcript.toLowerCase();
  let text = transcript;
  let applied = 0;
  for (const rule of rules) {
    if (rule.from.length === 0) continue;
    if (rule.requiresContext && rule.requiresContext.length > 0) {
      const hasContext = rule.requiresContext.some(
        (ctx2) => transcriptLower.includes(ctx2.toLowerCase())
      );
      if (!hasContext) continue;
    }
    const escaped = escapeRegex(rule.from);
    const firstChar = rule.from[0] ?? "";
    const lastChar = rule.from[rule.from.length - 1] ?? "";
    const startsWithWord = /\w/.test(firstChar);
    const endsWithWord = /\w/.test(lastChar);
    const leadGroup = startsWithWord ? "(^|\\W)" : "";
    const trailGroup = endsWithWord ? "(\\W|$)" : "";
    const pattern = `${leadGroup}${escaped}${trailGroup}`;
    const re = new RegExp(pattern, "gi");
    const hasLead = startsWithWord;
    const hasTrail = endsWithWord;
    const before = text;
    text = text.replace(re, (...args) => {
      const lead = hasLead ? args[1] ?? "" : "";
      const trail = hasTrail ? args[hasLead ? 2 : 1] ?? "" : "";
      return `${lead}${rule.to}${trail}`;
    });
    if (text !== before) applied++;
  }
  return { text, applied };
}
function registerIpcHandlers(ctx2) {
  electron.ipcMain.handle(Channels.InboxList, () => {
    const cfg = ctx2.getConfig();
    const swept = ctx2.state.sweepCompletedOlderThan(cfg.autoDismissCompleteMinutes);
    if (swept > 0) {
      ctx2.logger.info(
        { count: swept, thresholdMinutes: cfg.autoDismissCompleteMinutes },
        "auto-dismissed completed recordings"
      );
      ctx2.onStateChanged?.();
    }
    return ctx2.state.listActiveJoined().map(toInboxDTO);
  });
  electron.ipcMain.handle(Channels.InboxSkip, (_evt, recordingId) => {
    if (typeof recordingId !== "string") throw new Error("recordingId must be a string");
    const changed = ctx2.state.skipRecording(recordingId);
    if (changed) {
      ctx2.logger.info({ recordingId }, "recording skipped");
      ctx2.onStateChanged?.();
      broadcastInboxChanged();
    }
  });
  electron.ipcMain.handle(Channels.InboxRevealInFinder, (_evt, recordingId) => {
    if (typeof recordingId !== "string") throw new Error("recordingId must be a string");
    const row = ctx2.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (row.markdown_path) {
      electron.shell.showItemInFolder(row.markdown_path);
      return;
    }
    if (row.html_path) {
      electron.shell.showItemInFolder(row.html_path);
      return;
    }
    if (row.apple_note_id) {
      void electron.shell.openExternal("notes://");
      return;
    }
    throw new Error("No output written yet for this recording");
  });
  electron.ipcMain.handle(Channels.TagSave, (_evt, payload) => {
    const p = assertTagSavePayload(payload);
    const changed = ctx2.state.tagRecording(p.recordingId, p.clientId, p.meetingTypeId);
    if (!changed) {
      throw new Error(
        "Recording could not be tagged — it may already have been tagged or skipped."
      );
    }
    ctx2.logger.info(
      { recordingId: p.recordingId, clientId: p.clientId, meetingTypeId: p.meetingTypeId },
      "recording tagged"
    );
    ctx2.onStateChanged?.();
    broadcastInboxChanged();
    ctx2.getWorker()?.nudge();
  });
  electron.ipcMain.handle(Channels.TagOpenSheet, (_evt, recordingId) => {
    if (typeof recordingId !== "string") throw new Error("recordingId must be a string");
    const row = ctx2.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (row.status !== "inbox") {
      throw new Error(`Recording is no longer in the inbox (status=${row.status})`);
    }
    ctx2.logger.info({ recordingId }, "opening tag sheet");
    openTagSheet(recordingId);
  });
  electron.ipcMain.handle(Channels.PipelineCancel, (_evt, recordingId) => {
    if (typeof recordingId !== "string") throw new Error("recordingId must be a string");
    ctx2.logger.info({ recordingId }, "cancelling pipeline");
    ctx2.getWorker()?.cancel(recordingId);
    broadcastInboxChanged();
  });
  electron.ipcMain.handle(Channels.PipelineRetry, (_evt, recordingId) => {
    if (typeof recordingId !== "string") throw new Error("recordingId must be a string");
    const changed = ctx2.state.retry(recordingId);
    if (!changed) {
      throw new Error("Recording is not in a retryable state");
    }
    ctx2.logger.info({ recordingId }, "retrying pipeline");
    ctx2.onStateChanged?.();
    broadcastInboxChanged();
    ctx2.getWorker()?.nudge();
  });
  electron.ipcMain.handle(Channels.ClientsList, () => {
    return ctx2.state.listClients().map(toClientDTO);
  });
  electron.ipcMain.handle(Channels.ClientsAdd, (_evt, payload) => {
    const p = assertAddClientPayload(payload);
    const name = p.name.trim();
    if (name.length === 0) throw new Error("Client name cannot be empty");
    const existing = ctx2.state.listClients().find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) throw new Error(`A client named "${existing.name}" already exists`);
    const id = slugify(name) || `client-${node_crypto.randomUUID().slice(0, 8)}`;
    ctx2.state.upsertClient({ id, name, is_builtin: 0, sort_order: 500 });
    ctx2.logger.info({ clientId: id, name }, "client added");
    const saved = ctx2.state.getClient(id);
    return toClientDTO(saved);
  });
  electron.ipcMain.handle(Channels.MeetingTypesList, () => {
    return ctx2.state.listMeetingTypes().map(toMeetingTypeDTO);
  });
  electron.ipcMain.handle(Channels.MeetingTypesAdd, (_evt, payload) => {
    const p = assertAddMeetingTypePayload(payload);
    const name = p.name.trim();
    const prompt = p.prompt.trim();
    if (name.length === 0) throw new Error("Meeting type name cannot be empty");
    if (prompt.length === 0) throw new Error("Prompt cannot be empty");
    const existing = ctx2.state.listMeetingTypes().find(
      (m) => m.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) throw new Error(`A meeting type named "${existing.name}" already exists`);
    const id = slugify(name) || `meeting-type-${node_crypto.randomUUID().slice(0, 8)}`;
    ctx2.state.upsertMeetingType({
      id,
      name,
      prompt,
      is_builtin: 0,
      sort_order: 500,
      original_prompt_hash: null
    });
    ctx2.logger.info({ meetingTypeId: id, name }, "meeting type added");
    const saved = ctx2.state.getMeetingType(id);
    return toMeetingTypeDTO(saved);
  });
  electron.ipcMain.handle(
    Channels.MeetingTypesDelete,
    (_evt, id) => {
      if (typeof id !== "string") throw new Error("id must be a string");
      const existing = ctx2.state.getMeetingType(id);
      const displayName = existing?.name ?? id;
      const result = ctx2.state.deleteMeetingType(id);
      switch (result.kind) {
        case "deleted":
          ctx2.logger.info(
            {
              meetingTypeId: id,
              name: displayName,
              detachedCount: result.detachedCount
            },
            result.detachedCount > 0 ? "meeting type deleted; existing recordings detached" : "meeting type deleted"
          );
          return { deletedId: id };
        case "not-found":
          throw new Error(`No such meeting type: ${id}`);
        case "builtin":
          throw new Error(
            `"${displayName}" is a built-in prompt and can't be deleted. Use "Revert to default" to restore the original prompt text instead.`
          );
      }
    }
  );
  electron.ipcMain.handle(Channels.LocalImportPath, async (_evt, path2) => {
    if (typeof path2 !== "string") throw new Error("path must be a string");
    try {
      const result = await importLocalFile(path2, {
        state: ctx2.state,
        logger: ctx2.logger,
        onProgress: (p) => broadcastLocalImportProgress(p)
      });
      ctx2.onStateChanged?.();
      broadcastInboxChanged();
      return { recordingId: result.recordingId };
    } catch (e) {
      if (e instanceof LocalImportError) throw e;
      ctx2.logger.error({ err: String(e) }, "local import failed unexpectedly");
      throw new Error("Import failed. See logs for details.");
    }
  });
  electron.ipcMain.handle(Channels.LocalImportPickFiles, async () => {
    const result = await electron.dialog.showOpenDialog({
      title: "Import audio or video",
      buttonLabel: "Import",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Audio and video",
          extensions: ["mp3", "m4a", "wav", "aac", "ogg", "flac", "opus", "mp4", "mov", "m4v", "mkv", "webm"]
        },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (result.canceled) return [];
    return result.filePaths;
  });
  electron.ipcMain.handle(Channels.SettingsLoad, () => {
    const cfg = ctx2.getConfig();
    return {
      outputs: {
        markdown: { ...cfg.outputs.markdown },
        html: { ...cfg.outputs.html },
        appleNotes: { ...cfg.outputs.appleNotes }
      },
      prompts: ctx2.state.listMeetingTypes().map(toMeetingTypeDTO),
      vocabularyScopes: listVocabularyScopes(ctx2),
      general: toGeneralDTO(cfg),
      performance: toPerformanceDTO(cfg),
      sources: toSourcesDTO(ctx2)
    };
  });
  electron.ipcMain.handle(Channels.SettingsSaveOutputs, (_evt, payload) => {
    const outputs = assertOutputsDTO(payload);
    if (outputs.markdown.enabled && !outputs.markdown.dir.trim()) {
      throw new Error("Markdown output is enabled but no folder is set.");
    }
    if (outputs.html.enabled && !outputs.html.dir.trim()) {
      throw new Error("HTML output is enabled but no folder is set.");
    }
    if (outputs.appleNotes.enabled && !outputs.appleNotes.parentFolder.trim()) {
      throw new Error("Apple Notes output is enabled but no folder name is set.");
    }
    if (!outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled) {
      throw new Error("At least one output destination must be enabled.");
    }
    const updated = ctx2.applyConfigUpdate({ outputs });
    saveConfig(updated);
    ctx2.logger.info({ outputs: updated.outputs }, "outputs settings saved");
  });
  electron.ipcMain.handle(Channels.SettingsSavePrompt, (_evt, payload) => {
    const p = assertSavePromptPayload(payload);
    const prompt = p.prompt.trim();
    if (prompt.length === 0) throw new Error("Prompt cannot be empty.");
    const existing = ctx2.state.getMeetingType(p.id);
    if (!existing) throw new Error(`No such meeting type: ${p.id}`);
    const patch = { prompt };
    if (p.name !== void 0) {
      const newName = p.name.trim();
      if (newName.length === 0) throw new Error("Name cannot be empty.");
      const clash = ctx2.state.listMeetingTypes().find((m) => m.id !== p.id && m.name.toLowerCase() === newName.toLowerCase());
      if (clash) throw new Error(`A meeting type named "${clash.name}" already exists.`);
      patch.name = newName;
    }
    const changed = ctx2.state.updateMeetingType(p.id, patch);
    if (!changed) throw new Error(`Failed to update meeting type ${p.id}`);
    ctx2.logger.info(
      {
        meetingTypeId: p.id,
        promptChars: prompt.length,
        renamed: patch.name !== void 0,
        isBuiltin: existing.is_builtin === 1
      },
      "meeting-type prompt saved"
    );
    const updated = ctx2.state.getMeetingType(p.id);
    return toMeetingTypeDTO(updated);
  });
  electron.ipcMain.handle(
    Channels.SettingsRevertPromptToBuiltin,
    (_evt, id) => {
      if (typeof id !== "string") throw new Error("id must be a string");
      const existing = ctx2.state.getMeetingType(id);
      if (!existing) throw new Error(`No such meeting type: ${id}`);
      if (existing.is_builtin !== 1) {
        throw new Error(
          "Only built-in meeting types have a default to revert to."
        );
      }
      const seeded = readSeedPrompt(ctx2.resourcesDir, id);
      if (seeded === void 0) {
        throw new Error(
          `Could not find a seeded prompt for "${id}" in PROMPTS.md. This usually means the id has drifted between the seed list and PROMPTS.md — check that a "## N. \`${id}\`" heading still exists.`
        );
      }
      const seededHash = hashPrompt(seeded);
      const changed = ctx2.state.revertMeetingTypeToBuiltin(id, seeded, seededHash);
      if (!changed) throw new Error(`Failed to revert meeting type ${id}`);
      ctx2.logger.info({ meetingTypeId: id }, "meeting-type prompt reverted to default");
      if (existing.original_prompt_hash !== null && existing.original_prompt_hash !== seededHash) {
        ctx2.logger.warn(
          {
            meetingTypeId: id,
            previousSeedHash: existing.original_prompt_hash,
            newSeedHash: seededHash
          },
          "PROMPTS.md has drifted since original seed — reverted (and reseeded hash) to current file contents"
        );
      }
      const updated = ctx2.state.getMeetingType(id);
      return toMeetingTypeDTO(updated);
    }
  );
  electron.ipcMain.handle(
    Channels.SettingsImportPrompts,
    async () => {
      const result = await electron.dialog.showOpenDialog({
        title: "Import prompts from markdown",
        buttonLabel: "Import",
        properties: ["openFile"],
        filters: [
          { name: "Markdown", extensions: ["md", "markdown"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const sourcePath = result.filePaths[0];
      let raw;
      try {
        raw = node_fs.readFileSync(sourcePath, "utf-8");
      } catch (e) {
        throw new Error(
          `Could not read "${sourcePath}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
      const parsed = parsePromptsMarkdownDetailed(raw);
      if (parsed.length === 0) {
        throw new Error(
          `No prompts found in "${sourcePath}". The file should have headings like "## 1. \`my-id\` — My Display Name" with a fenced code block underneath each heading.`
        );
      }
      let created = 0;
      let updated = 0;
      for (const entry of parsed) {
        const trimmedPrompt = entry.prompt.trim();
        if (trimmedPrompt.length === 0) continue;
        const existing = ctx2.state.getMeetingType(entry.id);
        if (existing) {
          const namePatch = entry.name && entry.name !== existing.name ? (() => {
            const clash = ctx2.state.listMeetingTypes().find(
              (m) => m.id !== entry.id && m.name.toLowerCase() === entry.name.toLowerCase()
            );
            return clash ? void 0 : entry.name;
          })() : void 0;
          ctx2.state.updateMeetingType(entry.id, {
            ...namePatch !== void 0 ? { name: namePatch } : {},
            prompt: trimmedPrompt
          });
          updated++;
        } else {
          let name = entry.name;
          const nameClash = ctx2.state.listMeetingTypes().find((m) => m.name.toLowerCase() === name.toLowerCase());
          if (nameClash) name = `${name} (imported)`;
          ctx2.state.upsertMeetingType({
            id: entry.id,
            name,
            prompt: trimmedPrompt,
            is_builtin: 0,
            sort_order: 500,
            original_prompt_hash: null
          });
          created++;
        }
      }
      ctx2.logger.info(
        {
          sourcePath,
          parsedCount: parsed.length,
          created,
          updated
        },
        "prompts imported from markdown"
      );
      const prompts = ctx2.state.listMeetingTypes().map(toMeetingTypeDTO);
      return { created, updated, prompts };
    }
  );
  electron.ipcMain.handle(
    Channels.SettingsLoadVocabulary,
    (_evt, scopeId) => {
      if (typeof scopeId !== "string") throw new Error("scopeId must be a string");
      assertScopeIdExists(ctx2, scopeId);
      const file = readVocabularyFile(vocabularyDirFor(), scopeId);
      return toVocabularyFileDTO(file);
    }
  );
  electron.ipcMain.handle(
    Channels.SettingsSaveVocabulary,
    (_evt, payload) => {
      const p = assertSaveVocabularyPayload(payload);
      assertScopeIdExists(ctx2, p.scopeId);
      const existing = readVocabularyFile(vocabularyDirFor(), p.scopeId);
      const next = {
        $description: existing.$description,
        $version: existing.$version ?? 1,
        whisperHints: p.file.whisperHints,
        replacements: p.file.replacements.map((r) => ({
          from: r.from,
          to: r.to,
          ...r.requiresContext && r.requiresContext.length > 0 ? { requiresContext: r.requiresContext } : {}
        })),
        notes: p.file.notes
      };
      writeVocabularyFile(vocabularyDirFor(), p.scopeId, next);
      ctx2.logger.info(
        {
          scopeId: p.scopeId,
          hints: next.whisperHints?.length ?? 0,
          replacements: next.replacements?.length ?? 0,
          builtin: isBuiltinScopeId(p.scopeId)
        },
        "vocabulary scope saved"
      );
      return scopeSummary(ctx2, p.scopeId, next);
    }
  );
  electron.ipcMain.handle(
    Channels.SettingsImportVocabulary,
    async (_evt, scopeId) => {
      if (typeof scopeId !== "string") throw new Error("scopeId must be a string");
      assertScopeIdExists(ctx2, scopeId);
      const result = await electron.dialog.showOpenDialog({
        title: `Import vocabulary into "${scopeId}"`,
        buttonLabel: "Import",
        properties: ["openFile"],
        filters: [
          { name: "Vocabulary file", extensions: ["json", "md", "markdown"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const sourcePath = result.filePaths[0];
      let raw;
      try {
        raw = node_fs.readFileSync(sourcePath, "utf-8");
      } catch (e) {
        throw new Error(
          `Could not read "${sourcePath}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
      const lowerPath = sourcePath.toLowerCase();
      let importedHints = [];
      let importedReplacements = [];
      let importedNotes;
      let sourceFormat;
      if (lowerPath.endsWith(".json")) {
        sourceFormat = "json";
        let parsedJson;
        try {
          parsedJson = JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `Could not parse "${sourcePath}" as JSON: ${e instanceof Error ? e.message : String(e)}`
          );
        }
        const validated = assertSaveVocabularyPayload({
          scopeId,
          file: parsedJson
        });
        importedHints = validated.file.whisperHints;
        importedReplacements = validated.file.replacements;
        importedNotes = validated.file.notes;
      } else if (lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown")) {
        sourceFormat = "markdown";
        const tableRows = parseVocabularyMarkdownTables(raw);
        if (tableRows.length === 0) {
          throw new Error(
            `No vocabulary entries found in "${sourcePath}". The file should contain one or more markdown tables with the columns "Heard as", "Should be", and (optionally) "Context cue".`
          );
        }
        importedReplacements = tableRows.map((r) => ({
          from: r.from,
          to: r.to,
          ...r.requiresContext && r.requiresContext.length > 0 ? { requiresContext: r.requiresContext } : {}
        }));
      } else {
        throw new Error(
          `Unsupported file type: "${sourcePath}". Pick a .json vocabulary file or a .md / .markdown file with "Heard as / Should be / Context cue" tables.`
        );
      }
      const existing = readVocabularyFile(vocabularyDirFor(), scopeId);
      const mergedHints = mergeHints(
        existing.whisperHints ?? [],
        importedHints
      );
      const mergedReplacements = mergeReplacements(
        existing.replacements ?? [],
        importedReplacements
      );
      const mergedNotes = mergeNotes(existing.notes, importedNotes);
      const next = {
        $description: existing.$description,
        $version: existing.$version ?? 1,
        whisperHints: mergedHints,
        replacements: mergedReplacements,
        ...mergedNotes && mergedNotes.length > 0 ? { notes: mergedNotes } : {}
      };
      writeVocabularyFile(vocabularyDirFor(), scopeId, next);
      ctx2.logger.info(
        {
          scopeId,
          sourcePath,
          sourceFormat,
          existingHints: existing.whisperHints?.length ?? 0,
          importedHints: importedHints.length,
          mergedHints: mergedHints.length,
          existingReplacements: existing.replacements?.length ?? 0,
          importedReplacements: importedReplacements.length,
          mergedReplacements: mergedReplacements.length
        },
        "vocabulary import merged into scope"
      );
      return toVocabularyFileDTO(next);
    }
  );
  electron.ipcMain.handle(
    Channels.SettingsExportVocabulary,
    async (_evt, scopeId) => {
      if (typeof scopeId !== "string") throw new Error("scopeId must be a string");
      assertScopeIdExists(ctx2, scopeId);
      const file = readVocabularyFile(vocabularyDirFor(), scopeId);
      const defaultName = `${scopeId}-vocabulary.json`;
      const result = await electron.dialog.showSaveDialog({
        title: `Export vocabulary scope "${scopeId}"`,
        buttonLabel: "Export",
        defaultPath: defaultName,
        filters: [
          { name: "Vocabulary JSON", extensions: ["json"] },
          { name: "All files", extensions: ["*"] }
        ]
      });
      if (result.canceled || !result.filePath) return null;
      const serialised = JSON.stringify(file, null, 2) + "\n";
      try {
        node_fs.writeFileSync(result.filePath, serialised, "utf-8");
      } catch (e) {
        throw new Error(
          `Could not write to "${result.filePath}": ${e instanceof Error ? e.message : String(e)}`
        );
      }
      ctx2.logger.info(
        {
          scopeId,
          exportPath: result.filePath,
          hints: file.whisperHints?.length ?? 0,
          replacements: file.replacements?.length ?? 0
        },
        "vocabulary scope exported"
      );
      return { path: result.filePath };
    }
  );
  electron.ipcMain.handle(Channels.SettingsSaveGeneral, (_evt, payload) => {
    const general = assertGeneralDTO(payload);
    const updated = ctx2.applyConfigUpdate({
      audioRetentionDays: general.audioRetentionDays
    });
    saveConfig(updated);
    ctx2.logger.info(
      { audioRetentionDays: updated.audioRetentionDays },
      "general settings saved"
    );
  });
  electron.ipcMain.handle(Channels.SettingsSavePerformance, (_evt, payload) => {
    const perf = assertPerformanceDTO(payload);
    const cfg = ctx2.getConfig();
    const updated = ctx2.applyConfigUpdate({
      ollama: {
        ...cfg.ollama,
        model: perf.ollamaModel,
        keepAlive: perf.ollamaKeepAlive
      },
      whisperModel: perf.whisperModel
    });
    saveConfig(updated);
    ctx2.logger.info(
      {
        ollamaModel: updated.ollama.model,
        ollamaKeepAlive: updated.ollama.keepAlive,
        whisperModel: updated.whisperModel
      },
      "performance settings saved"
    );
  });
  electron.ipcMain.handle(
    Channels.SettingsListOllamaModels,
    async () => {
      const cfg = ctx2.getConfig();
      const client = new OllamaClient(cfg.ollama.host);
      const result = await client.listTags();
      if (!result.ok) {
        return { ok: false, reason: "unreachable", detail: result.detail };
      }
      const models = result.models.map((m) => ({
        name: m.name,
        sizeBytes: m.size
      }));
      return { ok: true, models };
    }
  );
  electron.ipcMain.handle(Channels.SettingsBrowseFolder, async (_evt, currentPath) => {
    const defaultPath = typeof currentPath === "string" && currentPath ? currentPath : void 0;
    const result = await electron.dialog.showOpenDialog({
      title: "Choose output folder",
      buttonLabel: "Select",
      properties: ["openDirectory", "createDirectory"],
      defaultPath
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
  electron.ipcMain.handle(
    Channels.SourcesPlaudSignIn,
    async (_evt, payload) => {
      const p = assertPlaudSignInPayload(payload);
      const store = ctx2.getPlaudStore();
      if (!store) {
        throw new Error(
          "Credential storage is not available. Restart the app and try again."
        );
      }
      try {
        await signInPlaud(store, {
          email: p.email,
          password: p.password,
          region: p.region
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx2.logger.warn({ err: msg, email: p.email }, "Plaud sign-in failed");
        try {
          await store.clearCredentialsAsync();
        } catch {
        }
        throw new Error(`Sign in failed: ${msg}`);
      }
      ctx2.logger.info({ email: p.email, region: p.region }, "Plaud sign-in successful");
      ctx2.onPlaudCredentialsChanged?.();
      return getPlaudAccountStatus(store);
    }
  );
  electron.ipcMain.handle(Channels.SourcesPlaudSignOut, async () => {
    const store = ctx2.getPlaudStore();
    if (!store) return;
    await signOutPlaud(store);
    ctx2.logger.info("Plaud signed out");
    ctx2.onPlaudCredentialsChanged?.();
  });
  electron.ipcMain.handle(Channels.SourcesPlaudStatus, () => {
    const store = ctx2.getPlaudStore();
    if (!store) return { signedIn: false };
    return getPlaudAccountStatus(store);
  });
  electron.ipcMain.handle(Channels.AppOpenSettings, (_evt, opts) => {
    const validTabs = /* @__PURE__ */ new Set([
      "sources",
      "outputs",
      "prompts",
      "vocabulary",
      "general",
      "performance",
      "about"
    ]);
    let initialTab;
    if (opts && typeof opts === "object") {
      const o = opts;
      if (typeof o.tab === "string" && validTabs.has(o.tab)) {
        initialTab = o.tab;
      }
    }
    openSettings(initialTab ? { initialTab } : void 0);
  });
  electron.ipcMain.handle(Channels.AppGetTipJarStatus, () => {
    return readTipJarStatus(ctx2.state);
  });
  electron.ipcMain.handle(Channels.AppDismissTipJarBanner, () => {
    dismissBanner(ctx2.state);
    ctx2.logger.info("tip-jar banner dismissed");
  });
  electron.ipcMain.handle(Channels.AppOpenTipJar, async () => {
    try {
      await electron.shell.openExternal(TIP_JAR_URL);
      ctx2.logger.info({ url: TIP_JAR_URL }, "tip-jar URL opened");
    } catch (e) {
      ctx2.logger.warn(
        { err: String(e), url: TIP_JAR_URL },
        "failed to open tip-jar URL"
      );
    }
  });
  electron.ipcMain.handle(Channels.SetupGetStatus, () => {
    const venvStatus = detectVenv();
    const systemPython = detectSystemPython();
    if (systemPython.kind === "not-found") {
      return {
        kind: "python-missing",
        triedPaths: systemPython.triedPaths
      };
    }
    return {
      kind: "needs-setup",
      systemPython: systemPython.path,
      systemPythonVersion: systemPython.version,
      reason: describeVenvStatus(venvStatus)
    };
  });
  electron.ipcMain.handle(
    Channels.SetupStart,
    async () => {
      const systemPython = detectSystemPython();
      if (systemPython.kind !== "found") {
        return {
          kind: "failed",
          phase: "creating-venv",
          message: "Python 3.11 was found at startup but is no longer reachable. Please re-launch distill."
        };
      }
      ctx2.logger.info(
        { systemPython: systemPython.path, version: systemPython.version },
        "starting venv install"
      );
      const result = await installVenv({
        systemPython: systemPython.path,
        logger: ctx2.logger,
        onProgress: (event) => {
          if (event.log) {
            broadcastSetupProgress({
              kind: "log",
              phase: event.phase,
              log: event.log
            });
          } else {
            broadcastSetupProgress({ kind: "phase", phase: event.phase });
          }
        }
      });
      if (result.kind === "success") {
        ctx2.logger.info(
          { pythonPath: result.pythonPath },
          "venv install succeeded"
        );
        broadcastSetupProgress({ kind: "done" });
        ctx2.onSetupComplete?.();
        return { kind: "success" };
      }
      if (result.kind === "failed") {
        ctx2.logger.warn(
          { phase: result.phase, message: result.message },
          "venv install failed"
        );
        broadcastSetupProgress({
          kind: "failed",
          failure: { phase: result.phase, message: result.message }
        });
        return result;
      }
      ctx2.logger.info("venv install cancelled");
      return { kind: "cancelled" };
    }
  );
  electron.ipcMain.handle(Channels.SetupQuit, () => {
    ctx2.logger.info("user quit from setup window");
    electron.app.quit();
  });
}
function broadcastInboxChanged() {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushInboxChanged);
  }
}
function broadcastFocusRecording(recordingId) {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushFocusRecording, recordingId);
  }
}
function broadcastLocalImportProgress(p) {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushLocalImportProgress, p);
  }
}
function broadcastSetupProgress(event) {
  for (const win of electron.BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(Channels.PushSetupProgress, event);
  }
}
function describeVenvStatus(status) {
  switch (status.kind) {
    case "ready":
      return "Already installed.";
    case "missing":
      return "Python environment not yet installed.";
    case "broken":
      return `Existing environment is broken (${status.reason}). Will rebuild.`;
    case "wrong-version":
      return `Existing environment uses ${status.foundVersion}; needs Python 3.11. Will rebuild.`;
    case "incomplete":
      return "Python environment exists but packages are missing. Will finish installing.";
  }
}
function toInboxDTO(r) {
  return {
    id: r.id,
    filename: r.filename,
    duration_seconds: r.duration_seconds,
    start_time: r.start_time,
    synced_at: r.synced_at,
    status: r.status,
    currentStep: statusToStep(r.status),
    clientName: r.client_name,
    meetingTypeName: r.meeting_type_name,
    error: r.error,
    isAuthError: r.is_auth_error === 1,
    markdownPath: r.markdown_path,
    vocabularySources: r.vocabulary_sources,
    vocabularyRulesApplied: r.vocabulary_rules_applied,
    truncationWarning: r.truncation_warning === 1,
    estimatedInputTokens: r.estimated_input_tokens,
    contextWindowAtSubmit: r.context_window_at_submit,
    modelSnapshot: r.model_snapshot,
    processedExternally: r.processed_externally === 1
  };
}
function statusToStep(s) {
  switch (s) {
    case "downloading":
      return "download";
    case "transcribing":
      return "transcribe";
    case "summarising":
      return "summarise";
    case "writing":
      return "write";
    default:
      return null;
  }
}
function toClientDTO(r) {
  return {
    id: r.id,
    name: r.name,
    is_builtin: r.is_builtin === 1,
    sort_order: r.sort_order
  };
}
function toMeetingTypeDTO(r) {
  const isBuiltin = r.is_builtin === 1;
  const is_modified = isBuiltin && r.original_prompt_hash !== null && hashPrompt(r.prompt) !== r.original_prompt_hash;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    is_builtin: isBuiltin,
    sort_order: r.sort_order,
    updated_at: r.updated_at,
    is_modified
  };
}
function toGeneralDTO(cfg) {
  return { audioRetentionDays: cfg.audioRetentionDays };
}
function toPerformanceDTO(cfg) {
  return {
    ollamaModel: cfg.ollama.model,
    ollamaKeepAlive: cfg.ollama.keepAlive,
    whisperModel: cfg.whisperModel
  };
}
function toSourcesDTO(ctx2) {
  const store = ctx2.getPlaudStore();
  return {
    plaud: store ? getPlaudAccountStatus(store) : { signedIn: false }
  };
}
function vocabularyDirFor(_ctx) {
  return userVocabularyDir();
}
const BUILTIN_SCOPE_LABELS = {
  global: "Global",
  organisation: "Organisation",
  industry: "Industry"
};
function listVocabularyScopes(ctx2) {
  const dir = vocabularyDirFor();
  const scopes = [];
  for (const id of BUILTIN_SCOPE_IDS) {
    scopes.push(scopeSummary(ctx2, id, readVocabularyFile(dir, id)));
  }
  for (const client of ctx2.state.listClients()) {
    if (isBuiltinScopeId(client.id)) continue;
    scopes.push(scopeSummary(ctx2, client.id, readVocabularyFile(dir, client.id)));
  }
  return scopes;
}
function scopeSummary(ctx2, scopeId, file) {
  const builtin = isBuiltinScopeId(scopeId);
  let label;
  if (builtin) {
    label = BUILTIN_SCOPE_LABELS[scopeId] ?? scopeId;
  } else {
    const client = ctx2.state.getClient(scopeId);
    label = client?.name ?? scopeId;
  }
  return {
    id: scopeId,
    label,
    builtin,
    termCount: countVocabularyTerms(file)
  };
}
function assertScopeIdExists(ctx2, scopeId) {
  if (isBuiltinScopeId(scopeId)) return;
  const client = ctx2.state.getClient(scopeId);
  if (!client) {
    throw new Error(
      `Unknown vocabulary scope: "${scopeId}". Must be one of: ${BUILTIN_SCOPE_IDS.join(", ")}, or a client id.`
    );
  }
}
function toVocabularyFileDTO(file) {
  return {
    whisperHints: [...file.whisperHints ?? []],
    replacements: (file.replacements ?? []).map((r) => ({
      from: r.from,
      to: r.to,
      ...r.requiresContext ? { requiresContext: [...r.requiresContext] } : {}
    })),
    ...file.notes ? { notes: [...file.notes] } : {}
  };
}
function mergeHints(existing, imported) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const h of existing) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  for (const h of imported) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
function mergeReplacements(existing, imported) {
  const importedByKey = /* @__PURE__ */ new Map();
  for (const r of imported) {
    importedByKey.set(r.from.toLowerCase(), r);
  }
  const out = [];
  for (const r of existing) {
    const key = r.from.toLowerCase();
    const fromImport = importedByKey.get(key);
    if (fromImport) {
      out.push({
        from: fromImport.from,
        to: fromImport.to,
        ...fromImport.requiresContext && fromImport.requiresContext.length > 0 ? { requiresContext: [...fromImport.requiresContext] } : {}
      });
      importedByKey.delete(key);
    } else {
      out.push({
        from: r.from,
        to: r.to,
        ...r.requiresContext && r.requiresContext.length > 0 ? { requiresContext: [...r.requiresContext] } : {}
      });
    }
  }
  for (const r of imported) {
    if (importedByKey.has(r.from.toLowerCase())) {
      out.push({
        from: r.from,
        to: r.to,
        ...r.requiresContext && r.requiresContext.length > 0 ? { requiresContext: [...r.requiresContext] } : {}
      });
      importedByKey.delete(r.from.toLowerCase());
    }
  }
  return out;
}
function mergeNotes(existing, imported) {
  if (!existing && !imported) return void 0;
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const n of existing ?? []) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  for (const n of imported ?? []) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : void 0;
}
function assertTagSavePayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid tag payload");
  const o = v;
  if (typeof o.recordingId !== "string") throw new Error("recordingId must be a string");
  if (typeof o.clientId !== "string") throw new Error("clientId must be a string");
  if (typeof o.meetingTypeId !== "string") throw new Error("meetingTypeId must be a string");
  return { recordingId: o.recordingId, clientId: o.clientId, meetingTypeId: o.meetingTypeId };
}
function assertAddClientPayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid client payload");
  const o = v;
  if (typeof o.name !== "string") throw new Error("name must be a string");
  return { name: o.name };
}
function assertAddMeetingTypePayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid meeting-type payload");
  const o = v;
  if (typeof o.name !== "string") throw new Error("name must be a string");
  if (typeof o.prompt !== "string") throw new Error("prompt must be a string");
  return { name: o.name, prompt: o.prompt };
}
function assertSavePromptPayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid prompt payload");
  const o = v;
  if (typeof o.id !== "string") throw new Error("id must be a string");
  if (typeof o.prompt !== "string") throw new Error("prompt must be a string");
  if (o.name !== void 0 && typeof o.name !== "string") {
    throw new Error("name must be a string when provided");
  }
  return {
    id: o.id,
    prompt: o.prompt,
    name: o.name
  };
}
function assertSaveVocabularyPayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid vocabulary payload");
  const o = v;
  if (typeof o.scopeId !== "string") throw new Error("scopeId must be a string");
  if (!o.file || typeof o.file !== "object") throw new Error("file must be an object");
  const f = o.file;
  if (!Array.isArray(f.whisperHints)) {
    throw new Error("file.whisperHints must be an array");
  }
  const hints = [];
  for (let i = 0; i < f.whisperHints.length; i++) {
    const h = f.whisperHints[i];
    if (typeof h !== "string") {
      throw new Error(`file.whisperHints[${i}] must be a string`);
    }
    const trimmed = h.trim();
    if (trimmed.length === 0) continue;
    hints.push(trimmed);
  }
  if (!Array.isArray(f.replacements)) {
    throw new Error("file.replacements must be an array");
  }
  const replacements = [];
  for (let i = 0; i < f.replacements.length; i++) {
    const rRaw = f.replacements[i];
    if (!rRaw || typeof rRaw !== "object") {
      throw new Error(`file.replacements[${i}] must be an object`);
    }
    const r = rRaw;
    if (typeof r.from !== "string" || typeof r.to !== "string") {
      throw new Error(
        `file.replacements[${i}]: "from" and "to" must both be strings`
      );
    }
    const fromTrim = r.from.trim();
    const toTrim = r.to.trim();
    if (fromTrim.length === 0 && toTrim.length === 0) continue;
    if (fromTrim.length === 0) {
      throw new Error(
        `file.replacements[${i}]: "from" is empty. Either fill it in or delete the row.`
      );
    }
    if (toTrim.length === 0) {
      throw new Error(
        `file.replacements[${i}] (from="${fromTrim}"): "to" is empty.`
      );
    }
    let requiresContext;
    if (r.requiresContext !== void 0) {
      if (!Array.isArray(r.requiresContext)) {
        throw new Error(
          `file.replacements[${i}] (from="${fromTrim}"): requiresContext must be an array`
        );
      }
      const ctx2 = r.requiresContext.map((c, j) => {
        if (typeof c !== "string") {
          throw new Error(
            `file.replacements[${i}].requiresContext[${j}] must be a string`
          );
        }
        return c.trim();
      }).filter((c) => c.length > 0);
      if (ctx2.length > 0) requiresContext = ctx2;
    }
    replacements.push({
      from: fromTrim,
      to: toTrim,
      ...requiresContext ? { requiresContext } : {}
    });
  }
  let notes;
  if (f.notes !== void 0) {
    if (!Array.isArray(f.notes)) {
      throw new Error("file.notes must be an array when provided");
    }
    notes = f.notes.map((n, i) => {
      if (typeof n !== "string") {
        throw new Error(`file.notes[${i}] must be a string`);
      }
      return n;
    });
  }
  return {
    scopeId: o.scopeId,
    file: {
      whisperHints: hints,
      replacements,
      ...notes ? { notes } : {}
    }
  };
}
function assertOutputsDTO(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid outputs payload");
  const o = v;
  const md = o.markdown;
  const html = o.html;
  const notes = o.appleNotes;
  if (!md || typeof md.enabled !== "boolean" || typeof md.dir !== "string" || typeof md.includeTranscript !== "boolean") {
    throw new Error("outputs.markdown is malformed");
  }
  if (!html || typeof html.enabled !== "boolean" || typeof html.dir !== "string" || typeof html.includeTranscript !== "boolean") {
    throw new Error("outputs.html is malformed");
  }
  if (!notes || typeof notes.enabled !== "boolean" || typeof notes.parentFolder !== "string" || typeof notes.includeTranscript !== "boolean") {
    throw new Error("outputs.appleNotes is malformed");
  }
  return {
    markdown: {
      enabled: md.enabled,
      dir: md.dir,
      includeTranscript: md.includeTranscript
    },
    html: {
      enabled: html.enabled,
      dir: html.dir,
      includeTranscript: html.includeTranscript
    },
    appleNotes: {
      enabled: notes.enabled,
      parentFolder: notes.parentFolder,
      includeTranscript: notes.includeTranscript
    }
  };
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}
function assertGeneralDTO(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid general payload");
  const o = v;
  const raw = o.audioRetentionDays;
  if (raw === null) return { audioRetentionDays: null };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error("audioRetentionDays must be null or a non-negative integer");
  }
  if (!Number.isInteger(raw)) {
    throw new Error("audioRetentionDays must be a whole number of days");
  }
  if (raw < 0) {
    throw new Error("audioRetentionDays must be ≥ 0 (use null to disable the sweep)");
  }
  return { audioRetentionDays: raw };
}
function assertPerformanceDTO(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid performance payload");
  const o = v;
  if (typeof o.ollamaModel !== "string") {
    throw new Error("ollamaModel must be a string");
  }
  const ollamaModel = o.ollamaModel.trim();
  if (ollamaModel.length === 0) {
    throw new Error("ollamaModel cannot be empty");
  }
  if (typeof o.ollamaKeepAlive !== "string") {
    throw new Error("ollamaKeepAlive must be a string");
  }
  const keepAlive = o.ollamaKeepAlive;
  const allowedKeepAlive = KEEPALIVE_PRESETS.map((p) => p.value);
  if (!allowedKeepAlive.includes(keepAlive)) {
    throw new Error(
      `ollamaKeepAlive must be one of: ${allowedKeepAlive.join(", ")}`
    );
  }
  if (typeof o.whisperModel !== "string") {
    throw new Error("whisperModel must be a string");
  }
  const whisperModel = o.whisperModel.trim();
  const allowedWhisper = WHISPER_MODEL_PRESETS.map((p) => p.value);
  if (!allowedWhisper.includes(whisperModel)) {
    throw new Error(
      `whisperModel must be one of the curated MLX models: ${allowedWhisper.join(", ")}`
    );
  }
  return {
    ollamaModel,
    ollamaKeepAlive: keepAlive,
    whisperModel
  };
}
function assertPlaudSignInPayload(v) {
  if (!v || typeof v !== "object") throw new Error("Invalid sign-in payload");
  const o = v;
  if (typeof o.email !== "string") throw new Error("email must be a string");
  if (typeof o.password !== "string") throw new Error("password must be a string");
  if (typeof o.region !== "string") throw new Error("region must be a string");
  const email = o.email.trim();
  if (email.length === 0) throw new Error("Email cannot be empty");
  if (o.password.length === 0) throw new Error("Password cannot be empty");
  if (o.region !== "us" && o.region !== "eu") {
    throw new Error('region must be "us" or "eu"');
  }
  return { email, password: o.password, region: o.region };
}
class CancelledError extends Error {
  constructor(step) {
    super(`Step '${step}' cancelled`);
    this.name = "CancelledError";
  }
}
function isCancelled(e) {
  return e instanceof CancelledError || e instanceof Error && e.name === "AbortError";
}
function cleanWhisperRepetitions(text) {
  if (!text || text.length === 0) {
    return { text, runsCollapsed: 0, charsRemoved: 0 };
  }
  let runsCollapsed = 0;
  let charsRemoved = 0;
  let cleaned = text;
  const singleWordPattern = /(\b[\w'']+\b)(?:[ \t\r\n.,!?]+\1\b){7,}/g;
  cleaned = cleaned.replace(singleWordPattern, (match, word) => {
    runsCollapsed += 1;
    const replacement = `${word} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });
  const multiWordPattern = /((?:\b[\w'']+\b[ \t]*){2,6}[.,!?]?)(?:[ \t\r\n]+\1){4,}/g;
  cleaned = cleaned.replace(multiWordPattern, (match, unit) => {
    runsCollapsed += 1;
    const trimmedUnit = unit.trim();
    const replacement = `${trimmedUnit} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });
  cleaned = cleaned.replace(/[ \t]{3,}/g, " ");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  return { text: cleaned, runsCollapsed, charsRemoved };
}
const OUTPUT_TOKEN_RESERVE = 3e3;
const CHARS_PER_TOKEN = 4;
function estimateTokenBudget(promptText, transcriptText, contextWindow) {
  const totalChars = promptText.length + transcriptText.length;
  const estimatedInputTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const budget = Math.max(0, contextWindow - OUTPUT_TOKEN_RESERVE);
  return {
    estimatedInputTokens,
    budget,
    exceedsBudget: estimatedInputTokens > budget,
    contextWindow
  };
}
function sanitiseForFilename(s) {
  return s.replace(/[/\\:*?"<>|]/g, "-").replace(/\s+/g, " ").replace(/^[.\s-]+|[.\s-]+$/g, "").trim() || "untitled";
}
function formatDateForFilename(startTimeMs) {
  const d = startTimeMs ? new Date(startTimeMs) : /* @__PURE__ */ new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}-${mi}`;
}
function extractTitleFromSummary(summary) {
  if (!summary) return null;
  const firstLine = summary.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  if (/^\d+[.)]\s/.test(firstLine)) return null;
  let title = firstLine.replace(/^#{1,6}\s+/, "").replace(/^>\s+/, "").replace(/^[-*]\s+/, "").replace(/^\*\*+|\*\*+$/g, "").replace(/^__+|__+$/g, "").replace(/^[*_]|[*_]$/g, "").trim();
  const HEADER_PATTERNS = [
    /^executive summary$/i,
    /^summary$/i,
    /^overview$/i,
    /^introduction$/i,
    /^meeting (minutes|notes|summary)$/i,
    /^transcript$/i
  ];
  for (const pat of HEADER_PATTERNS) {
    if (pat.test(title)) return null;
  }
  title = title.replace(/[.!?:;,]+$/, "").trim();
  if (title.length === 0) return null;
  const words = title.split(/\s+/);
  if (words.length > 15) {
    title = words.slice(0, 15).join(" ");
  }
  if (title.split(/\s+/).length < 3) return null;
  return title;
}
function buildFilenameStem(row) {
  const dateStr = formatDateForFilename(row.start_time);
  const client = sanitiseForFilename(row.client_name ?? "Unclassified");
  const extracted = extractTitleFromSummary(row.summary_text);
  const titleSource = extracted ?? row.filename;
  const title = sanitiseForFilename(titleSource).slice(0, 80);
  return `${dateStr} - ${client} - ${title}`;
}
function clientFolderName(row) {
  return sanitiseForFilename(row.client_name ?? "Unclassified");
}
function buildFilePath(baseDir, extension, row) {
  const dir = node_path.join(baseDir, clientFolderName(row));
  const stem = buildFilenameStem(row);
  return node_path.join(dir, `${stem}${extension}`);
}
function uniquifyPath(existsSync, primary, extension) {
  if (!existsSync(primary)) return primary;
  const stem = primary.slice(0, primary.length - extension.length);
  for (let n = 1; n <= 99; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem} (99)${extension}`;
}
async function writeMarkdown(row, opts) {
  if (!row.summary_text) {
    throw new Error("Cannot write markdown without a summary");
  }
  const primary = buildFilePath(opts.baseDir, ".md", row);
  const targetPath = uniquifyPath(node_fs.existsSync, primary, ".md");
  await promises.mkdir(node_path.dirname(targetPath), { recursive: true });
  const md = buildMarkdown(row, opts.includeTranscript);
  await promises.writeFile(targetPath, md, "utf-8");
  return { path: targetPath };
}
function buildMarkdown(row, includeTranscript) {
  const frontmatter = [
    "---",
    `recording_id: ${row.id}`,
    `filename: ${JSON.stringify(row.filename)}`,
    `client: ${JSON.stringify(row.client_name ?? "Unclassified")}`,
    `meeting_type: ${JSON.stringify(row.meeting_type_name ?? "Unknown")}`,
    row.start_time ? `date: ${new Date(row.start_time).toISOString()}` : null,
    row.duration_seconds != null ? `duration_seconds: ${row.duration_seconds}` : null,
    row.model_snapshot ? `model: ${JSON.stringify(row.model_snapshot)}` : null,
    row.whisper_snapshot ? `whisper_model: ${JSON.stringify(row.whisper_snapshot)}` : null,
    row.vocabulary_sources ? `vocabulary_sources: ${JSON.stringify(row.vocabulary_sources)}` : null,
    row.vocabulary_rules_applied != null ? `vocabulary_rules_applied: ${row.vocabulary_rules_applied}` : null,
    `transcript_embedded: ${includeTranscript}`,
    "---",
    ""
  ].filter((l) => l !== null).join("\n");
  const header = `# ${row.filename}

`;
  const summarySection = `## Summary

${row.summary_text?.trim() ?? ""}
`;
  if (!includeTranscript) return frontmatter + header + summarySection;
  const transcriptSection = `
---

## Transcript

${row.transcript_text?.trim() ?? ""}
`;
  return frontmatter + header + summarySection + transcriptSection;
}
async function writeHtml(row, opts) {
  if (!row.summary_text) {
    throw new Error("Cannot write HTML without a summary");
  }
  const primary = buildFilePath(opts.baseDir, ".html", row);
  const targetPath = uniquifyPath(node_fs.existsSync, primary, ".html");
  await promises.mkdir(node_path.dirname(targetPath), { recursive: true });
  const html = await buildHtmlDocument(row, opts.includeTranscript);
  await promises.writeFile(targetPath, html, "utf-8");
  return { path: targetPath, html };
}
async function buildHtmlDocument(row, includeTranscript) {
  const fragment = await buildHtmlFragment(row, includeTranscript);
  const title = escapeHtml(row.filename);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 14px/1.55 -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #1d1d1f; }
  h1 { font-size: 1.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; margin-top: 0; }
  h2 { font-size: 1.15em; margin-top: 1.6em; color: #333; }
  header.meta { font-size: 12px; color: #666; margin-bottom: 1.5em; }
  header.meta dt { font-weight: 600; display: inline; margin-right: 4px; }
  header.meta dd { display: inline; margin: 0 1em 0 0; }
  hr.divider { margin: 2em 0; border: none; border-top: 1px solid #eee; }
  .transcript { white-space: pre-wrap; font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px; color: #444; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #555; margin: 1em 0; }
  code { font-family: 'SF Mono', ui-monospace, monospace; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  pre code { display: block; padding: 1em; overflow-x: auto; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${fragment}
</body>
</html>
`;
}
async function buildHtmlFragment(row, includeTranscript) {
  const title = escapeHtml(row.filename);
  const meta = buildMetaBlock(row);
  const summaryHtml = await marked.marked.parse(row.summary_text ?? "", { async: true });
  let doc = `<h1>${title}</h1>
${meta}
<h2>Summary</h2>
${summaryHtml}
`;
  if (includeTranscript && row.transcript_text) {
    const transcriptHtml = escapeHtml(row.transcript_text.trim());
    doc += `<hr class="divider">
<h2>Transcript</h2>
<div class="transcript">${transcriptHtml}</div>
`;
  }
  return doc;
}
function buildMetaBlock(row) {
  const items = [];
  if (row.client_name) items.push(["Client", row.client_name]);
  if (row.meeting_type_name) items.push(["Type", row.meeting_type_name]);
  if (row.start_time) {
    items.push(["Date", new Date(row.start_time).toLocaleString()]);
  }
  if (row.duration_seconds != null) {
    items.push(["Duration", formatDuration$1(row.duration_seconds)]);
  }
  if (row.model_snapshot) items.push(["Model", row.model_snapshot]);
  if (row.vocabulary_rules_applied != null && row.vocabulary_rules_applied > 0) {
    items.push([
      "Corrections",
      `${row.vocabulary_rules_applied} applied (${row.vocabulary_sources ?? ""})`
    ]);
  }
  if (items.length === 0) return "";
  const dlEntries = items.map(
    ([k, v]) => `<dt>${escapeHtml(k)}:</dt><dd>${escapeHtml(v)}</dd>`
  ).join(" ");
  return `<header class="meta"><dl>${dlEntries}</dl></header>`;
}
function formatDuration$1(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds % 3600 / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
class AppleNotesError extends Error {
  constructor(userMessage, cause) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = "AppleNotesError";
    if (cause instanceof Error) this.stack = `${this.stack}
Caused by: ${cause.stack}`;
  }
}
async function writeAppleNote(row, opts) {
  if (!row.summary_text) {
    throw new AppleNotesError("Cannot write note without a summary");
  }
  const clientFolder = (row.client_name ?? "Unclassified").trim() || "Unclassified";
  const body = await buildHtmlFragment(row, opts.includeTranscript);
  const script = buildAppleScript({
    parentFolder: opts.parentFolder,
    clientFolder,
    body
  });
  const noteId = await runOsaScript(script);
  if (!noteId) {
    throw new AppleNotesError(
      "AppleScript ran but returned no note id. Check that Notes.app has permission — you may need to approve Automation permissions in System Settings."
    );
  }
  return { noteId };
}
function buildAppleScript(args) {
  const parent = escapeForAppleScript(args.parentFolder);
  const child = escapeForAppleScript(args.clientFolder);
  const body = escapeForAppleScript(args.body);
  return `
on run
  tell application "Notes"
    set acct to default account
    tell acct
      if not (exists folder "${parent}") then
        make new folder with properties {name:"${parent}"}
      end if
      tell folder "${parent}"
        if not (exists folder "${child}") then
          make new folder with properties {name:"${child}"}
        end if
        tell folder "${child}"
          set newNote to make new note with properties {body:"${body}"}
          return id of newNote
        end tell
      end tell
    end tell
  end tell
end run
`;
}
function escapeForAppleScript(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function runOsaScript(script) {
  return new Promise((resolve, reject) => {
    const proc = node_child_process.spawn("osascript", ["-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.once(
      "error",
      (err) => reject(
        new AppleNotesError(
          `Could not run osascript: ${err.message}. This should be built in on macOS — if it's missing, something is very wrong.`,
          err
        )
      )
    );
    proc.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const tail = stderr.split("\n").filter((l) => l.trim()).slice(-5).join("\n");
      if (/not authorized|permission/i.test(stderr)) {
        reject(
          new AppleNotesError(
            "macOS denied distill permission to control Notes.app. Open System Settings → Privacy & Security → Automation, find distill (or your Terminal in dev mode), and enable Notes."
          )
        );
        return;
      }
      if (/doesn.?t understand/i.test(stderr)) {
        reject(
          new AppleNotesError(
            `Notes.app rejected the AppleScript. This can happen on older macOS versions. Error: ${tail}`
          )
        );
        return;
      }
      reject(
        new AppleNotesError(
          `osascript failed (exit ${code}):
${tail || stderr.slice(-500)}`
        )
      );
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}
async function writeOutputs(row, outputs, logger2, skip = { markdown: false, html: false, appleNotes: false }) {
  const result = {
    markdownPath: null,
    htmlPath: null,
    appleNoteId: null,
    failures: [],
    successCount: 0,
    attemptedCount: 0
  };
  const tasks = [];
  if (outputs.markdown.enabled && !skip.markdown) {
    result.attemptedCount++;
    tasks.push(
      writeMarkdown(row, {
        baseDir: outputs.markdown.dir,
        includeTranscript: outputs.markdown.includeTranscript
      }).then((r) => {
        result.markdownPath = r.path;
        result.successCount++;
        logger2.info({ id: row.id, path: r.path }, "markdown output written");
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        result.failures.push({ destination: "markdown", message: msg });
        logger2.warn({ id: row.id, err: msg }, "markdown output failed");
      })
    );
  }
  if (outputs.html.enabled && !skip.html) {
    result.attemptedCount++;
    tasks.push(
      writeHtml(row, {
        baseDir: outputs.html.dir,
        includeTranscript: outputs.html.includeTranscript
      }).then((r) => {
        result.htmlPath = r.path;
        result.successCount++;
        logger2.info({ id: row.id, path: r.path }, "html output written");
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        result.failures.push({ destination: "html", message: msg });
        logger2.warn({ id: row.id, err: msg }, "html output failed");
      })
    );
  }
  if (outputs.appleNotes.enabled && !skip.appleNotes) {
    result.attemptedCount++;
    tasks.push(
      writeAppleNote(row, {
        parentFolder: outputs.appleNotes.parentFolder,
        includeTranscript: outputs.appleNotes.includeTranscript
      }).then((r) => {
        result.appleNoteId = r.noteId;
        result.successCount++;
        logger2.info({ id: row.id, noteId: r.noteId }, "apple note written");
      }).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        result.failures.push({ destination: "appleNotes", message: msg });
        logger2.warn({ id: row.id, err: msg }, "apple notes output failed");
      })
    );
  }
  await Promise.all(tasks);
  return result;
}
async function doDownload(id, signal, ctx2) {
  throwIfAborted(signal, "download");
  const url = await ctx2.plaud.getMp3Url(id);
  if (!url) throw new Error("Plaud did not return a download URL for this recording");
  const dir = audioDir();
  node_fs.mkdirSync(dir, { recursive: true });
  const dest = node_path.join(dir, `${id}.mp3`);
  if (node_fs.existsSync(dest)) node_fs.unlinkSync(dest);
  ctx2.logger.info({ id, dest }, "downloading audio");
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error("Download failed: empty response body");
  try {
    await promises$1.pipeline(
      node_stream.Readable.fromWeb(res.body),
      node_fs.createWriteStream(dest),
      { signal }
    );
  } catch (e) {
    if (node_fs.existsSync(dest)) {
      try {
        node_fs.unlinkSync(dest);
      } catch {
      }
    }
    if (isCancelled(e)) throw new CancelledError("download");
    throw e;
  }
  const size = node_fs.statSync(dest).size;
  if (size === 0) {
    node_fs.unlinkSync(dest);
    throw new Error("Downloaded file is empty");
  }
  ctx2.state.setStatus(id, "downloading", { audio_path: dest });
  ctx2.logger.info({ id, bytes: size }, "download complete");
}
async function doTranscribe(id, signal, ctx2) {
  throwIfAborted(signal, "transcribe");
  const row = ctx2.state.getRecording(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.audio_path) throw new Error("Cannot transcribe without an audio file");
  const vocabularyDir = userVocabularyDir();
  const vocab = loadVocabulary(vocabularyDir, row.client_id);
  if (vocab.sources.length > 0) {
    ctx2.logger.info(
      {
        id,
        sources: vocab.sources,
        hintsChars: vocab.whisperPrompt.length,
        replacements: vocab.replacements.length
      },
      "vocabulary loaded"
    );
  }
  const cfg = ctx2.getConfig();
  const pyBinary = resolvePythonBinary(ctx2.packageDir);
  const script = bundledTranscribeScript();
  const args = [script, "--audio", row.audio_path, "--whisper-model", cfg.whisperModel];
  if (vocab.whisperPrompt) {
    args.push("--initial-prompt", vocab.whisperPrompt);
  }
  ctx2.logger.info({ id, pyBinary, model: cfg.whisperModel }, "starting transcription");
  const proc = node_child_process.spawn(pyBinary, args, { signal });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exitCode = await new Promise((resolve, reject) => {
    proc.once("error", (err) => {
      if (isCancelled(err)) reject(new CancelledError("transcribe"));
      else reject(err);
    });
    proc.once("close", (code) => resolve(code ?? -1));
  });
  if (signal.aborted) throw new CancelledError("transcribe");
  if (exitCode !== 0) {
    throw new Error(`Transcription failed (exit ${exitCode}): ${stderr.slice(-500)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(
      `Transcription output was not valid JSON. Last 500 chars of stderr: ${stderr.slice(-500)}`
    );
  }
  if (!parsed.text || parsed.text.trim().length === 0) {
    throw new Error("Transcription produced an empty transcript");
  }
  const { text: corrected, applied } = applyReplacements(parsed.text, vocab.replacements);
  if (applied > 0) {
    ctx2.logger.info(
      { id, rulesApplied: applied, totalRules: vocab.replacements.length },
      "applied vocabulary replacements"
    );
  }
  const { text: cleaned, runsCollapsed, charsRemoved } = cleanWhisperRepetitions(corrected);
  if (runsCollapsed > 0) {
    ctx2.logger.info(
      { id, runsCollapsed, charsRemoved, originalChars: corrected.length },
      "cleaned whisper repetitions"
    );
  }
  ctx2.state.setStatus(id, "transcribing", {
    transcript_text: cleaned,
    whisper_snapshot: parsed.model,
    vocabulary_sources: vocab.sources.join(","),
    vocabulary_rules_applied: applied
  });
  ctx2.logger.info(
    { id, chars: corrected.length, language: parsed.language },
    "transcription complete"
  );
}
function resolvePythonBinary(packageDir) {
  const userVenv = venvPython();
  if (node_fs.existsSync(userVenv)) return userVenv;
  const devVenv = node_path.join(packageDir, "python", ".venv", "bin", "python");
  if (node_fs.existsSync(devVenv)) return devVenv;
  const legacyDevBin = node_path.join(bundledPythonDir(), "bin", "python");
  if (node_fs.existsSync(legacyDevBin)) return legacyDevBin;
  throw new Error(
    "No Python venv found. distill needs a venv at " + userVenv + " (created by first-launch setup) or in the dev tree. Open the app to run setup, or recreate the dev venv if you are running from source."
  );
}
async function doSummarise(id, signal, ctx2) {
  throwIfAborted(signal, "summarise");
  const row = ctx2.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.transcript_text) throw new Error("Cannot summarise without a transcript");
  if (!row.meeting_type_id) throw new Error("Cannot summarise without a meeting type");
  const meetingType = ctx2.state.getMeetingType(row.meeting_type_id);
  if (!meetingType) throw new Error(`Meeting type ${row.meeting_type_id} no longer exists`);
  const cfg = ctx2.getConfig();
  const budget = estimateTokenBudget(
    meetingType.prompt,
    row.transcript_text,
    cfg.ollama.contextWindow
  );
  if (budget.exceedsBudget) {
    ctx2.logger.warn(
      {
        id,
        estimatedInputTokens: budget.estimatedInputTokens,
        budget: budget.budget,
        contextWindow: budget.contextWindow,
        overshoot: budget.estimatedInputTokens - budget.budget
      },
      "transcript + prompt likely to exceed Ollama context budget; summary may be truncated"
    );
  }
  ctx2.logger.info(
    { id, model: cfg.ollama.model, transcriptChars: row.transcript_text.length, estimatedInputTokens: budget.estimatedInputTokens },
    "starting summarisation"
  );
  let response;
  try {
    response = await ctx2.ollama.chat(
      {
        model: cfg.ollama.model,
        messages: [
          { role: "system", content: meetingType.prompt },
          { role: "user", content: row.transcript_text }
        ],
        keep_alive: cfg.ollama.keepAlive,
        options: {
          num_ctx: cfg.ollama.contextWindow,
          temperature: cfg.ollama.temperature
        }
      },
      signal
    );
  } catch (e) {
    if (isCancelled(e)) throw new CancelledError("summarise");
    throw e;
  }
  const summary = response.message.content.trim();
  if (summary.length === 0) throw new Error("Ollama returned an empty summary");
  ctx2.state.setStatus(id, "summarising", {
    summary_text: summary,
    prompt_snapshot: meetingType.prompt,
    model_snapshot: response.model,
    truncation_warning: budget.exceedsBudget ? 1 : 0,
    estimated_input_tokens: budget.estimatedInputTokens,
    context_window_at_submit: budget.contextWindow
  });
  ctx2.logger.info({ id, chars: summary.length, truncationWarning: budget.exceedsBudget }, "summarisation complete");
}
async function doWriteOutputs(id, signal, ctx2) {
  throwIfAborted(signal, "write");
  const row = ctx2.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.summary_text) throw new Error("Cannot write outputs without a summary");
  const outputs = ctx2.getConfig().outputs;
  if (!outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled) {
    throw new Error(
      "No output destinations are enabled. Open Settings and turn on at least one of Markdown, HTML, or Apple Notes."
    );
  }
  const skip = {
    markdown: row.markdown_written_at !== null,
    html: row.html_written_at !== null,
    appleNotes: row.apple_note_written_at !== null
  };
  const result = await writeOutputs(row, outputs, ctx2.logger, skip);
  const now = Date.now();
  const patch = {};
  if (result.markdownPath !== null) {
    patch.markdown_path = result.markdownPath;
    patch.markdown_written_at = now;
  }
  if (result.htmlPath !== null) {
    patch.html_path = result.htmlPath;
    patch.html_written_at = now;
  }
  if (result.appleNoteId !== null) {
    patch.apple_note_id = result.appleNoteId;
    patch.apple_note_written_at = now;
  }
  if (result.failures.length > 0) {
    if (Object.keys(patch).length > 0) {
      ctx2.state.setStatus(id, "writing", patch);
    }
    const msg = result.failures.map((f) => `${f.destination}: ${f.message}`).join("; ");
    throw new Error(
      result.successCount === 0 ? `All output destinations failed. ${msg}` : `Partial output failure (${result.successCount}/${result.attemptedCount} attempted succeeded this run). ${msg}`
    );
  }
  patch.error = null;
  ctx2.state.setStatus(id, "writing", patch);
  ctx2.logger.info(
    {
      id,
      attempted: result.attemptedCount,
      succeeded: result.successCount,
      skippedAsAlreadyWritten: {
        markdown: skip.markdown,
        html: skip.html,
        appleNotes: skip.appleNotes
      },
      markdownPath: result.markdownPath,
      htmlPath: result.htmlPath,
      appleNoteId: result.appleNoteId
    },
    "outputs written"
  );
}
function throwIfAborted(signal, step) {
  if (signal.aborted) throw new CancelledError(step);
}
const RULES = [
  // --- Ollama --------------------------------------------------------------
  {
    // Both "ECONNREFUSED" (Node fetch on a closed port) and Ollama's own
    // "connection refused" come through here. We key on the 11434 default
    // port to make sure we're specifically talking about Ollama.
    pattern: /ECONNREFUSED.*?:?11434|Connection refused|Ollama is not reachable/i,
    build: () => "Ollama is not running. Start it from the menu bar or run `ollama serve` in Terminal, then click Retry."
  },
  {
    // Ollama returns 404 for missing models; also responds "model not found"
    // in JSON error bodies in some versions.
    pattern: /Ollama\s+404|model\s+"?([^"\s]+)"?\s+not\s+found|pull the model first/i,
    build: (_m, ctx2) => {
      const model = ctx2.ollamaModel ?? "the configured model";
      return `Ollama model "${model}" is not installed. Pull it with: ollama pull ${model}`;
    }
  },
  {
    pattern: /Ollama\s+stream\s+error|Ollama\s+5\d\d/i,
    build: () => "Ollama errored during generation. This usually means it ran out of memory — try a smaller model, shorter transcript, or restart Ollama."
  },
  {
    pattern: /Ollama\s+response\s+had\s+no\s+body|Ollama\s+stream\s+ended\s+without/i,
    build: () => "Ollama closed the connection before finishing. If this repeats, restart the Ollama app."
  },
  // --- Plaud download ------------------------------------------------------
  {
    pattern: /getMp3Url\s+returned\s+null|Plaud\s+did\s+not\s+return\s+a\s+download\s+URL/i,
    build: () => "Plaud did not return a download URL for this recording. It may have been deleted on the Plaud cloud — try Sync, then retry, or skip if it is gone."
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+40[13]/i,
    build: () => "Plaud refused the download (auth expired). Open Settings → Sources to sign in again.",
    isAuthError: true
  },
  {
    // Surfaces when the poller / pipeline runs after a Sign Out has
    // cleared credentials but a row was already in flight. Also covers
    // the case where a user newly installed and never signed in.
    pattern: /No\s+credentials\s+configured|Plaud\s+not\s+(?:authenticated|signed\s+in)/i,
    build: () => "Not signed in to Plaud. Open Settings → Sources to sign in.",
    isAuthError: true
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+404/i,
    build: () => "Plaud returned 404 for this recording — it has probably been deleted server-side. You can safely skip it."
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+5\d\d/i,
    build: () => "Plaud had a server error during download. Retry in a minute or two."
  },
  {
    pattern: /Downloaded\s+file\s+is\s+empty/i,
    build: () => "The downloaded audio file was empty. Retry; if it happens again the cloud copy may be corrupt."
  },
  // --- Transcription (Python / MLX) ---------------------------------------
  {
    pattern: /Transcription\s+failed\s+\(exit\s+(-?\d+)\)/i,
    build: (m) => {
      const code = m[1];
      return `Transcription crashed (exit ${code}). Check the log for the Python traceback; common causes are out-of-memory on very long recordings or a corrupt audio file.`;
    }
  },
  {
    pattern: /Transcription\s+output\s+was\s+not\s+valid\s+JSON/i,
    build: () => "Whisper finished but its output was malformed. Check the log — this is usually a warning Python printed to stdout by mistake."
  },
  {
    pattern: /Transcription\s+produced\s+an\s+empty\s+transcript/i,
    build: () => "Whisper returned no text. The audio may be silent, music-only, or too short for speech detection."
  },
  {
    // Python ModuleNotFoundError, most often mlx_whisper venv not set up.
    // Remediation differs between dev and packaged:
    //   - dev: rebuild the venv with uv pip install
    //   - packaged: delete the user-data venv so first-launch setup
    //               re-runs on relaunch (no source tree available)
    pattern: /ModuleNotFoundError.*mlx_whisper|No module named\s+['"]mlx_whisper['"]/i,
    build: (_m, ctx2) => {
      if (ctx2.isPackaged && ctx2.appSupportDir) {
        return `mlx_whisper is not installed in the Python venv. Quit distill, delete ${ctx2.appSupportDir}/venv, and re-launch to re-run first-launch setup.`;
      }
      return "mlx_whisper is not installed in the Python venv. Run: cd packages/app/python && uv pip install -r requirements.txt";
    }
  },
  // --- Filesystem ----------------------------------------------------------
  {
    pattern: /ENOSPC|no\s+space\s+left\s+on\s+device/i,
    build: () => "Disk is full. Free space and retry."
  },
  {
    pattern: /EACCES|permission\s+denied/i,
    build: (m, ctx2) => {
      const dir = ctx2.appSupportDir ?? "~/Library/Application Support/distill";
      return `Permission denied: ${m[0]}. Check file/folder permissions around ${dir} and the Markdown output folder.`;
    }
  },
  {
    pattern: /ENOENT.*\.mp3/i,
    build: () => "The audio file on disk has gone missing (was it deleted manually?). Cancel this recording and re-pull from Plaud if needed."
  },
  // --- Network -------------------------------------------------------------
  {
    pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    build: () => "DNS lookup failed. Check your internet connection; Plaud and Ollama both need to be reachable."
  },
  {
    pattern: /aborted|The operation was aborted/i,
    build: () => "The operation was aborted. This is usually a cancel-in-flight, but if you did not cancel, it might be a network hiccup — retry."
  }
];
function prettifyError(rawMessage, ctx2 = {}) {
  const msg = rawMessage.trim();
  if (!msg) return { message: "Unknown error", isAuthError: false };
  for (const rule of RULES) {
    const match = msg.match(rule.pattern);
    if (match) {
      return {
        message: rule.build(match, ctx2),
        isAuthError: rule.isAuthError === true
      };
    }
  }
  const firstLine = msg.split("\n")[0] ?? msg;
  const trimmed = firstLine.length > 200 ? firstLine.slice(0, 197) + "…" : firstLine;
  return { message: trimmed, isAuthError: false };
}
class Worker {
  constructor(ctx2, cb) {
    this.ctx = ctx2;
    this.cb = cb;
  }
  running = false;
  stopRequested = false;
  currentId = null;
  currentAbort = null;
  /**
   * Revert interrupted rows and nudge the worker. Call once during app
   * startup, after the State is opened.
   */
  recoverOnStartup() {
    const recovered = this.ctx.state.recoverInterrupted();
    if (recovered.length > 0) {
      this.ctx.logger.warn(
        { ids: recovered, count: recovered.length },
        "recovered interrupted recordings — will resume from last checkpoint"
      );
    }
    this.nudge();
  }
  /**
   * Wake the worker. Call after any tag save, retry, or recovery.
   * Multiple calls while running are coalesced \u2014 the worker naturally
   * picks up new tagged rows on its next iteration.
   */
  nudge() {
    if (!this.running && !this.stopRequested) {
      void this.loop();
    }
  }
  /**
   * Cancel a specific recording. If it's the one currently running, aborts
   * the in-flight step immediately. Either way, marks the row as
   * `cancelled` and cleans up partial audio.
   */
  cancel(id) {
    const prevRow = this.ctx.state.cancel(id);
    if (!prevRow) return;
    if (this.currentId === id && this.currentAbort) {
      this.currentAbort.abort();
    }
    if (prevRow.audio_path && node_fs.existsSync(prevRow.audio_path) && !prevRow.markdown_path) {
      try {
        node_fs.unlinkSync(prevRow.audio_path);
        this.ctx.state.setStatus(id, "cancelled", { audio_path: null });
        this.ctx.logger.info({ id, path: prevRow.audio_path }, "removed audio on cancel");
      } catch (e) {
        this.ctx.logger.warn({ id, err: String(e) }, "failed to remove audio on cancel");
      }
    }
    this.cb.onStateChanged();
  }
  /**
   * Signal the worker to stop between iterations. Does NOT abort an
   * in-flight step \u2014 the pipeline lets the current step finish so the
   * row stays in a consistent state (e.g. partial write avoided). Callers
   * that need immediate abort should additionally call cancel(id) for the
   * currently running recording.
   */
  stop() {
    this.stopRequested = true;
  }
  async loop() {
    this.running = true;
    try {
      while (!this.stopRequested) {
        const cfg = this.ctx.getConfig();
        const allowed = /* @__PURE__ */ new Set([
          "write"
        ]);
        if (shouldRunStep(cfg.paused, "download")) allowed.add("download");
        if (shouldRunStep(cfg.paused, "transcribe")) allowed.add("transcribe");
        if (shouldRunStep(cfg.paused, "summarise")) allowed.add("summarise");
        const claimed = this.ctx.state.claimNextTagged(allowed);
        if (!claimed) break;
        this.cb.onStateChanged();
        const abort = new AbortController();
        this.currentId = claimed.id;
        this.currentAbort = abort;
        try {
          await this.runPipelineForId(claimed.id, abort.signal);
          const final = this.ctx.state.getRecording(claimed.id);
          if (final && final.status !== "cancelled" && final.status !== "error") {
            this.ctx.state.setStatus(claimed.id, "complete");
            this.cb.onComplete(claimed.id);
          }
        } catch (e) {
          if (isCancelled(e)) {
            this.ctx.logger.info({ id: claimed.id }, "pipeline cancelled");
          } else {
            const rawMsg = e instanceof Error ? e.message : String(e);
            this.ctx.logger.error({ id: claimed.id, err: rawMsg }, "pipeline failed");
            const row = this.ctx.state.getRecording(claimed.id);
            const cfg2 = this.ctx.getConfig();
            const friendly = prettifyError(rawMsg, {
              step: row?.last_step ?? null,
              ollamaHost: cfg2.ollama.host,
              ollamaModel: cfg2.ollama.model,
              appSupportDir: this.ctx.appSupportDir,
              isPackaged: this.ctx.isPackaged
            });
            this.ctx.state.setStatus(claimed.id, "error", {
              error: friendly.message,
              is_auth_error: friendly.isAuthError ? 1 : 0
            });
          }
        } finally {
          this.currentId = null;
          this.currentAbort = null;
          this.cb.onStateChanged();
        }
      }
    } finally {
      this.running = false;
    }
  }
  async runPipelineForId(id, signal) {
    const afterClaim = this.ctx.state.getRecording(id);
    if (!afterClaim) return;
    if (!afterClaim.audio_path) {
      if (!shouldRunStep(this.ctx.getConfig().paused, "download")) {
        this.ctx.state.setStatus(id, "tagged");
        return;
      }
      this.ctx.state.setStatus(id, "downloading", { last_step: "download" });
      this.cb.onStateChanged();
      await doDownload(id, signal, this.ctx);
    }
    const afterDownload = this.ctx.state.getRecording(id);
    if (!afterDownload) return;
    if (!afterDownload.transcript_text) {
      if (!shouldRunStep(this.ctx.getConfig().paused, "transcribe")) {
        this.ctx.state.setStatus(id, "tagged");
        return;
      }
      this.ctx.state.setStatus(id, "transcribing", { last_step: "transcribe" });
      this.cb.onStateChanged();
      await doTranscribe(id, signal, this.ctx);
    }
    const afterTranscribe = this.ctx.state.getRecording(id);
    if (!afterTranscribe) return;
    if (!afterTranscribe.summary_text) {
      if (!shouldRunStep(this.ctx.getConfig().paused, "summarise")) {
        this.ctx.state.setStatus(id, "tagged");
        return;
      }
      this.ctx.state.setStatus(id, "summarising", { last_step: "summarise" });
      this.cb.onStateChanged();
      await doSummarise(id, signal, this.ctx);
    }
    const afterSummarise = this.ctx.state.getRecording(id);
    if (!afterSummarise) return;
    this.ctx.state.setStatus(id, "writing", { last_step: "write" });
    this.cb.onStateChanged();
    await doWriteOutputs(id, signal, this.ctx);
  }
}
function decideForRow(row, retentionDays, nowMs) {
  if (retentionDays === null) {
    return { kind: "keep", reason: "retention disabled" };
  }
  if (row.source !== "local") {
    return { kind: "keep", reason: "plaud source" };
  }
  if (row.status !== "complete" && row.status !== "skipped") {
    return { kind: "keep", reason: `status=${row.status}` };
  }
  if (!row.audio_path) {
    return { kind: "keep", reason: "no audio_path" };
  }
  const writes = [
    row.markdown_written_at,
    row.html_written_at,
    row.apple_note_written_at
  ].filter((t) => typeof t === "number");
  if (writes.length === 0) {
    return { kind: "keep", reason: "no successful writes recorded" };
  }
  const mostRecentWrite = Math.max(...writes);
  const ageMs = nowMs - mostRecentWrite;
  const thresholdMs = retentionDays * 24 * 60 * 60 * 1e3;
  if (ageMs < thresholdMs) {
    const ageDays2 = Math.floor(ageMs / (24 * 60 * 60 * 1e3));
    return {
      kind: "keep",
      reason: `last write ${ageDays2}d ago (threshold ${retentionDays}d)`
    };
  }
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1e3));
  return {
    kind: "delete",
    reason: `last write ${ageDays}d ago (>= threshold ${retentionDays}d)`
  };
}
const nodeFs = {
  existsSync: node_fs.existsSync,
  unlinkSync: node_fs.unlinkSync
};
function sweepStateFor(state2) {
  return {
    listLocalCandidates() {
      return state2.db.prepare(
        `SELECT id, source, status, audio_path,
                  markdown_written_at, html_written_at, apple_note_written_at
           FROM recordings
           WHERE source = 'local'`
      ).all();
    },
    updateRecording(id, patch) {
      state2.updateRecording(id, patch);
    }
  };
}
function runSweep(state2, retentionDays, fs2, logger2, nowMs = Date.now()) {
  const result = {
    deleted: [],
    alreadyMissing: [],
    failed: [],
    considered: 0
  };
  if (retentionDays === null) {
    logger2.debug("audio retention disabled (audioRetentionDays=null)");
    return result;
  }
  const candidates = state2.listLocalCandidates();
  result.considered = candidates.length;
  for (const row of candidates) {
    const decision = decideForRow(row, retentionDays, nowMs);
    if (decision.kind === "keep") {
      logger2.debug(
        { recordingId: row.id, reason: decision.reason },
        "audio retention: keep"
      );
      continue;
    }
    const path2 = row.audio_path;
    if (!fs2.existsSync(path2)) {
      state2.updateRecording(row.id, { audio_path: null });
      result.alreadyMissing.push({ id: row.id, path: path2 });
      logger2.debug(
        { recordingId: row.id, path: path2 },
        "audio retention: file already missing, cleared audio_path"
      );
      continue;
    }
    try {
      fs2.unlinkSync(path2);
      state2.updateRecording(row.id, { audio_path: null });
      result.deleted.push({ id: row.id, path: path2 });
      logger2.info(
        { recordingId: row.id, path: path2, reason: decision.reason },
        "audio retention: deleted"
      );
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      result.failed.push({ id: row.id, path: path2, error: err });
      logger2.warn(
        { recordingId: row.id, path: path2, error: err },
        "audio retention: unlink failed"
      );
    }
  }
  return result;
}
function startSweepSchedule(opts) {
  const intervalMs = opts.intervalMs ?? 24 * 60 * 60 * 1e3;
  const safeRun = () => {
    try {
      runSweep(opts.state, opts.getRetentionDays(), opts.fs, opts.logger);
    } catch (e) {
      opts.logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        "audio retention sweep threw unexpectedly"
      );
    }
  };
  safeRun();
  const handle = setInterval(safeRun, intervalMs);
  return () => clearInterval(handle);
}
electron.app.dock?.hide();
if (!electron.app.requestSingleInstanceLock()) {
  electron.app.quit();
}
let trayHandle = null;
let state = null;
let poller = null;
let worker = null;
let logger = null;
let stopAudioSweep = null;
let plaudStore = null;
const pendingFileDrops = [];
let appReady = false;
electron.app.on("open-file", (event, path2) => {
  event.preventDefault();
  if (appReady) {
    void handleFileDrop(path2);
  } else {
    pendingFileDrops.push(path2);
  }
});
async function handleFileDrop(path2) {
  if (!state) return;
  const log = logger;
  try {
    const result = await importLocalFile(path2, {
      state,
      logger: log ?? { info: () => {
      }, warn: () => {
      }, error: () => {
      } }
    });
    trayHandle?.refresh();
    broadcastInboxChanged();
    openInbox(void 0, result.recordingId);
    broadcastFocusRecording(result.recordingId);
  } catch (e) {
    const msg = e instanceof LocalImportError ? e.userMessage : `Import failed: ${String(e)}`;
    log?.warn({ err: String(e), path: path2 }, "file drop import failed");
    electron.dialog.showErrorBox("distill — import failed", msg);
  }
}
electron.app.whenReady().then(async () => {
  const resourcesDir = bundledResourcesDir();
  const appSupportDirPath = appSupportDir();
  try {
    migrateScopeRenames(userVocabularyDir());
    migrateVocabularyToUserDir(
      node_path.join(bundledResourcesDir(), "vocabulary"),
      userVocabularyDir()
    );
  } catch (e) {
    console.warn("vocabulary migration threw:", e);
  }
  let cfg;
  try {
    cfg = loadConfig(resourcesDir);
  } catch (e) {
    if (e instanceof ConfigMissingError) {
      electron.dialog.showErrorBox(
        "distill — install looks broken",
        `No config file at ${e.expectedPath}, and no bundled example to bootstrap from. The app install may be incomplete. Try reinstalling distill, or place a config.json at the path above.`
      );
      electron.app.quit();
      return;
    }
    throw e;
  }
  const localLogger = createLogger({ level: cfg.logLevel, pretty: !electron.app.isPackaged });
  logger = localLogger;
  localLogger.info({ cfg }, "distill starting");
  let localState;
  try {
    const db = openDatabase();
    localState = new State(db);
    state = localState;
    const seedResult = seedIfEmpty(state, resourcesDir);
    for (const note of seedResult.notes) localLogger.info(note);
  } catch (e) {
    const msg = e instanceof Error ? e.stack ?? e.message : String(e);
    localLogger.fatal({ err: msg }, "startup failed during SQLite init");
    electron.dialog.showErrorBox("distill failed to start", msg);
    electron.app.quit();
    return;
  }
  configureWindows({
    preloadPath: node_path.join(electron.app.getAppPath(), "out", "preload", "index.js"),
    rendererDevUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    rendererDistDir: node_path.join(electron.app.getAppPath(), "out", "renderer")
  });
  const applyConfigUpdate = (patch) => {
    cfg = normaliseConfig({ ...cfg, ...patch });
    return cfg;
  };
  registerIpcHandlers({
    state: localState,
    logger: localLogger,
    resourcesDir,
    getConfig: () => cfg,
    applyConfigUpdate,
    // Lazy getter — the worker is constructed after Plaud connects, below.
    // Any IPC that fires before then will get null, which the pipeline
    // handlers tolerate (nudge and cancel are no-ops without a worker).
    getWorker: () => worker,
    // Plaud credential store is constructed later in this whenReady
    // block, so use a getter so the IPC handlers see it once it exists.
    getPlaudStore: () => plaudStore,
    onPlaudCredentialsChanged: () => {
      notify({
        title: "distill — restart to apply",
        body: "Restart distill to start syncing with the new Plaud account."
      });
    },
    onStateChanged: () => trayHandle?.refresh(),
    onSetupComplete: () => {
      void continueBootstrap();
    }
  });
  const devVenvPath = node_path.join(
    electron.app.getAppPath(),
    "python",
    ".venv",
    "bin",
    "python"
  );
  const installStatus = getInstallationStatus(devVenvPath);
  localLogger.info(
    {
      kind: installStatus.kind,
      pythonPath: installStatus.kind === "ready" ? installStatus.pythonPath : null,
      source: installStatus.kind === "ready" ? installStatus.source : void 0
    },
    "python install status"
  );
  if (installStatus.kind === "ready") {
    await continueBootstrap();
  } else {
    localLogger.info(
      { reason: installStatus.kind },
      "opening setup window"
    );
    openSetup();
    return;
  }
  async function continueBootstrap() {
    const tray = createTray({
      state: localState,
      logger: localLogger,
      resourcesDir,
      getConfig: () => cfg,
      onSyncNow: async () => {
        if (!poller) return;
        localLogger.info("manual sync requested");
        await poller.syncNow();
      },
      onOpenInbox: (bounds) => {
        openInbox(bounds);
        broadcastInboxChanged();
      },
      onOpenSettings: () => openSettings(),
      onPauseChange: (nextPause) => {
        const updated = applyConfigUpdate({ paused: nextPause });
        saveConfig(updated);
        trayHandle?.refresh();
        worker?.nudge();
        localLogger.info({ paused: nextPause }, "pause settings changed");
      }
    });
    trayHandle = tray;
    const ollama = new OllamaClient(cfg.ollama.host);
    try {
      const pf = await ollama.preflight(cfg.ollama.model);
      if (!pf.ok) {
        const msg = preflightMessage(pf);
        localLogger.warn({ preflight: pf }, "Ollama pre-flight failed");
        tray.setOllamaWarning(
          `Ollama: ${pf.reason === "unreachable" ? "not running" : "model missing"}`
        );
        notify({ title: "distill — Ollama check failed", body: msg });
      } else {
        localLogger.info({ model: pf.model }, "Ollama pre-flight ok");
        tray.setOllamaWarning(null);
      }
    } catch (e) {
      localLogger.warn({ err: String(e) }, "Ollama pre-flight errored (non-fatal)");
    }
    plaudStore = new KeychainCredentialStore();
    await plaudStore.prime();
    try {
      const result = await migratePasswordToKeychain();
      if (result === "migrated") {
        localLogger.info("migrated Plaud password from config.json to Keychain");
      } else if (result === "kept-as-fallback") {
        localLogger.info(
          "Plaud password still in config.json (no Keychain copy yet); will migrate on first sign-in"
        );
      }
    } catch (e) {
      localLogger.warn(
        { err: String(e) },
        "password migration failed (non-fatal; legacy file path still works)"
      );
    }
    try {
      const conn = connect(plaudStore);
      localLogger.info({ region: conn.region }, "Plaud connection ready");
      worker = new Worker(
        {
          state: localState,
          // Pass a getter rather than `cfg` directly so the worker picks up
          // Settings edits (output destinations, Ollama model, etc.) between
          // steps without needing an app restart.
          getConfig: () => cfg,
          logger: localLogger,
          ollama,
          plaud: conn.client,
          packageDir: electron.app.getAppPath(),
          // Used by prettifyError for path-aware messages (EACCES,
          // mlx_whisper missing). Both come from electron / paths
          // so they're set here rather than imported in errorMessages
          // (which keeps that module test-runnable in plain Node).
          appSupportDir: appSupportDirPath,
          isPackaged: electron.app.isPackaged
        },
        {
          onStateChanged: () => {
            trayHandle?.refresh();
            broadcastInboxChanged();
          },
          onComplete: (id) => {
            const row = localState.getRecordingJoined(id);
            if (!row) return;
            localLogger.info(
              { id, client: row.client_name, path: row.markdown_path },
              "pipeline complete"
            );
            notify({
              title: "Summary ready",
              body: row.client_name && row.meeting_type_name ? `${row.client_name} — ${row.meeting_type_name}` : row.filename,
              onClick: () => {
                if (row.markdown_path) electron.shell.showItemInFolder(row.markdown_path);
              }
            });
            try {
              const outcome = recordCompletion(localState);
              if (outcome.kind === "threshold-just-hit") {
                localLogger.info(
                  { count: outcome.count },
                  "tip-jar threshold reached — firing one-shot notification"
                );
                notify({
                  title: `${outcome.count} summaries done — nice work`,
                  body: "Glad distill is earning its keep. If you'd like to support development, you can keep me caffeinated. Tap to open the tip jar.",
                  onClick: () => {
                    void electron.shell.openExternal(TIP_JAR_URL).catch(
                      (err) => localLogger.warn(
                        { err: String(err) },
                        "failed to open tip-jar URL from notification click"
                      )
                    );
                  }
                });
              }
            } catch (e) {
              localLogger.warn(
                { err: String(e), id },
                "tip-jar bookkeeping failed (non-fatal)"
              );
            }
          }
        }
      );
      worker.recoverOnStartup();
      poller = new Poller({
        state: localState,
        client: conn.client,
        intervalMinutes: cfg.pollIntervalMinutes,
        logger: localLogger,
        // Polling is paused when either the master switch is on or the
        // dedicated polling flag is set. The poller treats this as a
        // "don't start new work" signal and emits a `skipped-paused`
        // result without contacting Plaud.
        shouldPause: () => cfg.paused.all || cfg.paused.polling,
        // Cross-machine completion lookup. Scans the configured Markdown
        // output dir for files whose frontmatter recording_id matches a
        // recording the poller is about to insert; matches are inserted
        // as `complete` / `processed_externally = 1` rather than going
        // to the inbox to be re-processed. When Markdown output is
        // disabled, the lookup returns an empty Map and behaviour falls
        // back to single-machine semantics. See processedElsewhere.ts
        // for the design.
        loadProcessedElsewhere: async () => {
          if (!cfg.outputs.markdown.enabled) return /* @__PURE__ */ new Map();
          const dir = expandHome(cfg.outputs.markdown.dir);
          return loadProcessedElsewhereIds(dir);
        },
        onPoll: (result, fresh) => {
          tray.setLastPoll(result);
          tray.refresh();
          if (result.kind === "ok" && fresh.length > 0) {
            for (const r of fresh) {
              const seconds = typeof r.duration === "number" ? r.duration / 1e3 : null;
              notify({
                title: "New recording",
                body: `${r.filename} · ${formatDuration(seconds)} — tap to tag`,
                onClick: () => {
                  openInbox(void 0, r.id);
                  broadcastFocusRecording(r.id);
                }
              });
            }
          }
        }
      });
      poller.start();
    } catch (e) {
      if (e instanceof PlaudNotAuthenticatedError) {
        localLogger.error({ err: e.message }, "Plaud not authenticated");
        notify({
          title: "distill — sign in needed",
          body: "Open Settings -> Sources to sign in to Plaud."
        });
        tray.setOllamaWarning("Plaud: not signed in");
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        localLogger.error({ err: msg }, "failed to start Plaud poller");
        tray.setOllamaWarning(`Plaud: ${msg}`);
      }
    }
    localLogger.info(
      {
        inbox: localState.inboxCount(),
        errors: localState.errorCount(),
        clients: localState.listClients().length,
        meetingTypes: localState.listMeetingTypes().length
      },
      "distill ready"
    );
    stopAudioSweep = startSweepSchedule({
      state: sweepStateFor(localState),
      getRetentionDays: () => cfg.audioRetentionDays,
      fs: nodeFs,
      logger: localLogger
    });
    appReady = true;
    if (pendingFileDrops.length > 0) {
      localLogger.info({ count: pendingFileDrops.length }, "processing deferred file drops");
      const deferred = pendingFileDrops.splice(0, pendingFileDrops.length);
      for (const path2 of deferred) {
        void handleFileDrop(path2);
      }
    }
  }
});
electron.app.on("before-quit", () => {
  closeAll();
  worker?.stop();
  poller?.stop();
  stopAudioSweep?.();
  trayHandle?.destroy();
  state?.close();
});
electron.app.on("window-all-closed", () => {
});
function formatDuration(seconds) {
  if (seconds == null) return "?";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, "0")}s`;
  return `${r}s`;
}
