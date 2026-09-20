/**
 * Typed IPC contract between the Electron main process and all renderer
 * windows (inbox + tag sheet).
 *
 * This file is imported by:
 *   - main/ipc.ts      (registers handlers for each `invoke` channel)
 *   - preload/index.ts (exposes methods via contextBridge)
 *   - renderer code    (calls through window.distill.*)
 *
 * Keeping the contract here means TypeScript catches drift across all three
 * sides. Every request/response is fully typed — no `any` leaks.
 *
 * Conventions:
 *   - Channels are namespaced: `domain.action` (e.g. `inbox.list`).
 *   - Main → renderer pushes use `push:*` channels (e.g. `push:inbox-changed`).
 *   - All errors are surfaced as rejected promises; the preload rewraps any
 *     thrown Error so the renderer sees a normal Error object.
 */

// ---------------------------------------------------------------------------
// Pipeline vocabulary — mirrored from main/state.ts to avoid importing main
// into renderer code.
// ---------------------------------------------------------------------------

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

export type PipelineStep = 'download' | 'transcribe' | 'summarise' | 'write';

export function isActiveStatus(s: RecordingStatus): boolean {
  return s === 'tagged' || s === 'downloading' || s === 'transcribing' || s === 'summarising' || s === 'writing';
}

// ---------------------------------------------------------------------------
// Shared DTOs — kept narrow. The renderer does NOT see the full SQLite row.
// ---------------------------------------------------------------------------

export interface InboxRecordingDTO {
  id: string;
  filename: string;
  duration_seconds: number | null;
  start_time: number | null; // epoch milliseconds (Plaud returns ms, not seconds)
  synced_at: number; // epoch ms
  status: RecordingStatus;
  /** Populated when status is one of the pipeline-running states. */
  currentStep: PipelineStep | null;
  /** Client display name, once tagged. */
  clientName: string | null;
  /** Meeting type display name, once tagged. */
  meetingTypeName: string | null;
  /** Last error message for rows in status='error'. */
  error: string | null;
  /**
   * True iff `error` is an authentication error that the user can
   * resolve by signing in again to a source (today: Plaud). The
   * inbox UI surfaces a "Sign in again" button that opens Settings
   * → Sources directly when this is set. Always false when status
   * isn't 'error'. Determined in the main process by `errorMessages.ts`
   * — the renderer never inspects the message text itself.
   */
  isAuthError: boolean;
  /** Filesystem path to the Markdown output for rows in status='complete'. */
  markdownPath: string | null;
  /** Comma-separated vocabulary filenames that contributed (null if transcription hasn't run). */
  vocabularySources: string | null;
  /** Number of replacement rules that fired on the transcript. */
  vocabularyRulesApplied: number | null;
  /**
   * True iff the summarise step submitted an input larger than the
   * effective context budget. The inbox UI surfaces this as a yellow
   * badge on the completed row — the summary may be missing detail
   * from the start of the meeting because Ollama silently truncated.
   * Always false until the summarise step has run.
   */
  truncationWarning: boolean;
  /**
   * Estimated input tokens at submit time (chars/4 over prompt +
   * transcript). Null until the summarise step has run. Surfaced in
   * the inbox warning badge tooltip so the user can see by how much
   * the row exceeded its budget.
   */
  estimatedInputTokens: number | null;
  /**
   * The `num_ctx` value the row was submitted with. Null until the
   * summarise step has run. Paired with `estimatedInputTokens` for
   * the warning badge tooltip.
   */
  contextWindowAtSubmit: number | null;
  /**
   * Ollama model id used to produce the summary, e.g. "qwen2.5:32b".
   * Null until the summarise step has run. Surfaced in the inbox
   * for `processedExternally` rows so the user can see at a glance
   * which model produced a cross-machine summary (the M4 and M5
   * may use different models because of different RAM ceilings).
   */
  modelSnapshot: string | null;
  /**
   * True when this row was inserted as `complete` because another
   * machine had already processed the recording. The pipeline never
   * ran on this machine; `markdownPath`, `modelSnapshot`, and
   * `whisperSnapshot` reflect what the other machine wrote. The
   * inbox UI surfaces a small "processed on another machine" hint
   * with the model name so the user knows the summary may have
   * been produced with a different model than this machine would
   * use today.
   */
  processedExternally: boolean;
}

export interface ClientDTO {
  id: string;
  name: string;
  is_builtin: boolean;
  sort_order: number;
}

export interface MeetingTypeDTO {
  id: string;
  name: string;
  prompt: string;
  is_builtin: boolean;
  sort_order: number;
  updated_at: number;
  /**
   * True iff this is a built-in meeting type and its prompt text
   * differs from the originally-seeded default. Always false for
   * user-created types (they have no default to differ from). The
   * Prompts pane uses this to surface a "modified" badge and to
   * decide whether to show the "revert to default" button. See
   * DECISIONS.md §3.
   */
  is_modified: boolean;
}

// ---------------------------------------------------------------------------
// Request / response shapes per channel
// ---------------------------------------------------------------------------

export interface TagSavePayload {
  recordingId: string;
  clientId: string;
  meetingTypeId: string;
}

export interface AddClientPayload {
  name: string;
}

export interface AddMeetingTypePayload {
  name: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Settings DTOs. Mirror the AppConfig output section so the renderer
// doesn't have to import main-process types.
//
// Following DECISIONS.md §3, load is unified (one call returns every
// section's data) but save is per-section (one channel per tab). The
// Settings window therefore calls `load()` once on open, then calls
// `saveOutputs()` / `savePrompt()` / `saveVocabulary()` from the
// appropriate tab's Save button. A failure in one tab's save doesn't
// affect the others, and each handler asserts only its own slice.
// ---------------------------------------------------------------------------

export interface OutputsDTO {
  markdown: {
    enabled: boolean;
    dir: string;
    includeTranscript: boolean;
  };
  html: {
    enabled: boolean;
    dir: string;
    includeTranscript: boolean;
  };
  appleNotes: {
    enabled: boolean;
    parentFolder: string;
    includeTranscript: boolean;
  };
}

export interface SettingsDTO {
  outputs: OutputsDTO;
  /**
   * Full list of meeting types (built-in + user-added) with their
   * prompts and modified-from-default flag. Populated on every
   * settings.load() so the Prompts tab has everything it needs
   * without a second round-trip. See DECISIONS.md §3.
   */
  prompts: MeetingTypeDTO[];
  /**
   * Metadata about every vocabulary scope — the three built-in packs
   * (global, organisation, industry) plus one per client. File
   * contents are loaded on-demand via
   * `settings.loadVocabulary(scopeId)` to keep this payload small
   * even as vocab packs grow. See DECISIONS.md §2.
   */
  vocabularyScopes: VocabularyScopeSummaryDTO[];
  /** App-level general settings (audio retention, etc.). */
  general: GeneralDTO;
  /** Pipeline performance / model settings (Ollama + Whisper). */
  performance: PerformanceDTO;
  /**
   * Source-connector status (Plaud today; future sources slot in here).
   * The Sources pane reads this on load to render the list. Sign-in
   * and sign-out happen via dedicated channels rather than the unified
   * save path, since they involve network round-trips and the UI
   * needs to react to success/failure individually.
   */
  sources: SourcesDTO;
}

// ---------------------------------------------------------------------------
// General settings DTO. Tri-state semantics for audioRetentionDays:
//   - null: never sweep (audio kept forever).
//   - 0:    delete as soon as a row enters complete/skipped status.
//   - N>0:  delete N days after the most recent *_written_at timestamp.
// Only locally-imported rows are ever swept; Plaud-sourced audio is
// always kept because it can be re-fetched.
// ---------------------------------------------------------------------------

export interface GeneralDTO {
  audioRetentionDays: number | null;
}

export type SaveGeneralPayload = GeneralDTO;

// ---------------------------------------------------------------------------
// Performance settings DTO. Mirrors the subset of AppConfig.ollama and
// AppConfig.whisperModel that's user-tunable from the Performance pane.
// keepAlive uses Ollama's duration-string format ('5m', '30m', etc.);
// the UI ships a curated dropdown of presets — see KEEPALIVE_PRESETS.
// ---------------------------------------------------------------------------

export interface PerformanceDTO {
  /** Ollama model id, e.g. "qwen2.5:32b". */
  ollamaModel: string;
  /** Ollama keep_alive duration, e.g. "5m", "24h", or "0" for off. */
  ollamaKeepAlive: string;
  /** MLX Whisper HuggingFace repo id, e.g. "mlx-community/whisper-large-v3-mlx". */
  whisperModel: string;
}

export type SavePerformancePayload = PerformanceDTO;

/**
 * One installed Ollama model, returned by `settings.listOllamaModels`.
 * `sizeBytes` is taken from /api/tags' `size` field; the renderer
 * formats it for display.
 */
export interface OllamaModelDTO {
  name: string;
  sizeBytes: number;
}

/**
 * Result of listing Ollama models. Tagged so the UI can distinguish
 * "Ollama is fine, here are the models" from "Ollama is unreachable,
 * the picker should be disabled". A successful result with an empty
 * `models` array is also valid (Ollama running but no models pulled
 * — the UI surfaces a clear message).
 */
export type OllamaModelsResult =
  | { ok: true; models: OllamaModelDTO[] }
  | { ok: false; reason: 'unreachable'; detail: string };

/**
 * Curated keepAlive presets shown in the Performance pane dropdown.
 * Order matches the dropdown order; `value` is what gets persisted.
 * Free-text entry is intentionally not supported — mistyped durations
 * are a silent failure in Ollama.
 */
export const KEEPALIVE_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '0', label: 'Off (unload immediately)' },
  { value: '5m', label: '5 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
];

/**
 * Curated MLX Whisper model dropdown. Closed list rather than free
 * text because mistyping an MLX HuggingFace id silently downloads
 * the wrong model — the python script doesn't validate ids, it just
 * passes them through to mlx_whisper.transcribe(). See BACKLOG
 * "Audio retention cleanup" → Performance pane for the rationale.
 */
export const WHISPER_MODEL_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'mlx-community/whisper-large-v3-mlx', label: 'Large v3 (best quality, slowest)' },
  { value: 'mlx-community/whisper-large-v3-turbo', label: 'Large v3 Turbo (faster)' },
  { value: 'mlx-community/whisper-medium-mlx', label: 'Medium' },
  { value: 'mlx-community/whisper-small-mlx', label: 'Small' },
  { value: 'mlx-community/whisper-base-mlx', label: 'Base' },
  { value: 'mlx-community/whisper-tiny-mlx', label: 'Tiny (fastest, lowest quality)' },
];

export interface SavePromptPayload {
  id: string;
  /**
   * Leave undefined to leave the name unchanged. Built-in types
   * should typically keep their default names; user-created types
   * can be renamed freely.
   */
  name?: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Vocabulary DTOs. Mirror the shape of the JSON files on disk so the
// renderer doesn't have to know about the file layout. See DECISIONS.md
// §2 — vocabulary stays as JSON files; the Settings pane edits them
// in place.
// ---------------------------------------------------------------------------

export interface VocabularyReplacementDTO {
  from: string;
  to: string;
  /**
   * Optional context words. When set, the replacement only fires if
   * at least one of these words appears elsewhere in the transcript.
   * Used for homophones (e.g. "sim" → "CIM" only in marketing context).
   */
  requiresContext?: string[];
}

export interface VocabularyFileDTO {
  /**
   * Terms Whisper should know about. Seeded into its initial_prompt
   * at transcription time. Capitalisation, punctuation, and spacing
   * should match how the term is spoken.
   */
  whisperHints: string[];
  replacements: VocabularyReplacementDTO[];
  /**
   * Free-text notes attached to the file. Not used by the pipeline;
   * surfaced in the editor so authors can document why a rule exists.
   */
  notes?: string[];
}

export interface VocabularyScopeSummaryDTO {
  /** Filename stem (e.g. "global", "organisation", "acme-corp"). */
  id: string;
  /** Display name. Built-ins use fixed labels; clients use their client.name. */
  label: string;
  /** True for the three always-applied packs: global, organisation, industry. */
  builtin: boolean;
  /** whisperHints + replacements count, for the sidebar badge. */
  termCount: number;
}

export interface SaveVocabularyPayload {
  scopeId: string;
  file: VocabularyFileDTO;
}

// ---------------------------------------------------------------------------
// The typed API surface exposed to the renderer via contextBridge.
// Keep this in sync with preload/index.ts (exposeInMainWorld call) and
// main/ipc.ts (ipcMain.handle registrations).
// ---------------------------------------------------------------------------

export interface DistillApi {
  inbox: {
    list(): Promise<InboxRecordingDTO[]>;
    skip(recordingId: string): Promise<void>;
    /**
     * Reveal the Markdown output for a completed recording in Finder.
     * No-op if the recording is not yet complete.
     */
    revealInFinder(recordingId: string): Promise<void>;
  };

  pipeline: {
    /**
     * Cancel an in-flight recording. Valid for statuses
     * `tagged|downloading|transcribing|summarising|writing`. Stops any
     * running step, deletes partial audio, and moves the recording to
     * `cancelled`. Safe to call multiple times; subsequent calls are no-ops.
     */
    cancel(recordingId: string): Promise<void>;
    /**
     * Re-enqueue a recording that is currently in `error` or `cancelled`.
     * The pipeline resumes from the first step whose output has not yet
     * been produced, so prior work is never redone unnecessarily.
     */
    retry(recordingId: string): Promise<void>;
  };

  tag: {
    open(recordingId: string): Promise<void>;
    save(payload: TagSavePayload): Promise<void>;
    getSheetRecordingId(): string | null;
  };

  clients: {
    list(): Promise<ClientDTO[]>;
    add(payload: AddClientPayload): Promise<ClientDTO>;
  };

  meetingTypes: {
    list(): Promise<MeetingTypeDTO[]>;
    add(payload: AddMeetingTypePayload): Promise<MeetingTypeDTO>;
    /**
     * Delete a user-created meeting type. Rejects with a clear,
     * user-readable message if the type is built-in (they re-seed
     * on next launch) or if any recording row references it via
     * `meeting_type_id` (deleting would either FK-fail or, with
     * cascade, silently rewrite history). The renderer surfaces
     * either condition as a regular error message; both states are
     * recoverable without code changes (built-ins are protected by
     * design; in-use can be resolved by skipping or completing the
     * referencing rows, then retrying).
     *
     * Returns the id of the deleted type on success so the
     * renderer can drop it from its local list without a re-fetch.
     */
    delete(id: string): Promise<{ deletedId: string }>;
  };

  localImport: {
    /**
     * Import a single local file (drag-and-drop, Finder Open…, Dock drop).
     * Accepts audio files directly (mp3/m4a/wav/aac/ogg/flac/opus) and
     * video containers with audio tracks (mp4/mov/m4v/mkv/webm); video
     * requires ffmpeg on PATH. Returns the new recording id on success;
     * rejects with a user-readable error message on failure.
     *
     * Progress for the in-flight import is pushed via
     * `onLocalImportProgress`. The renderer queues multiple
     * imports by calling this method sequentially.
     */
    importPath(path: string): Promise<{ recordingId: string }>;
    /**
     * Open a native file picker (multi-select enabled) and return the
     * paths the user chose. Does NOT perform the imports — the renderer
     * is responsible for queuing them through `importPath` one at a
     * time, which lets the UI show a per-file queue and progress
     * indicator. Returns an empty array when the user cancels.
     */
    pickFiles(): Promise<string[]>;
    /**
     * Resolve a dropped File to its filesystem path. Prefers
     * webUtils.getPathForFile (Electron 32+); falls back to File.path for
     * older runtimes. Synchronous on purpose — it's a pure property read.
     */
    getPathForFile(file: File): string;
  };

  settings: {
    /** Read the current user-configurable settings. */
    load(): Promise<SettingsDTO>;
    /**
     * Save the Outputs section only. See DECISIONS.md §3 — saves are
     * per-section so a vocab-save failure can't block an outputs-save
     * and vice versa. The main process writes to config.json and
     * updates its in-memory AppConfig so subsequent pipeline runs see
     * the new values. Rejects if the payload is malformed or the
     * write fails.
     */
    saveOutputs(payload: OutputsDTO): Promise<void>;
    /**
     * Save a single meeting-type prompt (and optionally its name).
     * Does not touch other prompts — per-prompt saves keep the
     * Prompts pane's failure surface narrow. Rejects on empty prompt
     * or unknown id.
     *
     * In-flight summaries aren't affected: the pipeline snapshots
     * the prompt into `prompt_snapshot` at step start, so a save
     * mid-pipeline only affects subsequent summaries.
     */
    savePrompt(payload: SavePromptPayload): Promise<MeetingTypeDTO>;
    /**
     * Restore a built-in meeting type's prompt to its seeded default
     * from PROMPTS.md. No-op (and rejects) for user-created types —
     * they have no default to revert to. Returns the updated DTO so
     * the UI can refresh without a separate load call.
     */
    revertPromptToBuiltin(id: string): Promise<MeetingTypeDTO>;
    /**
     * Open a native file picker, read the chosen markdown file,
     * parse it with the same `parsePromptsMarkdown` parser used for
     * PROMPTS.md, and UPSERT the prompts it contains into
     * `meeting_types`. Each section's id (the backticked id in its
     * heading: `## N. \`<id>\` — ...`) is matched against existing
     * meeting_types rows:
     *
     *   - Existing id (built-in or user-created): prompt text is
     *     replaced; `original_prompt_hash` and `is_builtin` are left
     *     untouched. The Settings pane reflects the new prompt next
     *     time it loads.
     *   - New id: a new user-created meeting type is created with
     *     `is_builtin = 0`, the parsed name (taken from the heading
     *     after the em-dash, or falling back to the id), and the
     *     parsed prompt body.
     *
     * Resolves null if the user cancels the picker. Rejects on
     * malformed markdown (no parseable id headings) or on I/O
     * errors. The `count` field on success is the number of
     * upserts performed; `created` and `updated` break that down
     * so the renderer can show "Imported N prompts (X new, Y
     * updated)".
     *
     * In-flight summaries aren't affected: the pipeline snapshots
     * the prompt into `prompt_snapshot` at step start, so a save
     * mid-pipeline only affects subsequent summaries.
     */
    importPrompts(): Promise<{
      created: number;
      updated: number;
      prompts: MeetingTypeDTO[];
    } | null>;
    /**
     * Read the full contents of a single vocabulary scope. Returns
     * an empty-shape file for a scope whose JSON doesn't exist yet
     * (a client scope that's never been saved). Throws on malformed
     * JSON. See DECISIONS.md §2.
     */
    loadVocabulary(scopeId: string): Promise<VocabularyFileDTO>;
    /**
     * Write a single vocabulary scope to disk. Creates the file on
     * first save. Rejects on shape violations (empty `from`, empty
     * `to`, malformed `requiresContext`). Built-in packs are writable
     * like any other scope — changes go straight into the git-tracked
     * JSON files. See DECISIONS.md §2.
     */
    saveVocabulary(payload: SaveVocabularyPayload): Promise<VocabularyScopeSummaryDTO>;
    /**
     * Open a native file picker, read the chosen JSON, validate it,
     * MERGE it with the current contents of the scope, and write the
     * result. Returns the merged file so the editor can refresh
     * without a separate load call. Resolves null if the user cancels
     * the picker.
     *
     * Merge semantics (import-wins on conflicts):
     *   - Whisper hints: union, dedup case-insensitive, imported
     *     entries appended to existing.
     *   - Replacements: deduped by `from` value (case-insensitive);
     *     when the same `from` exists in both, the imported version
     *     wins. Order: imports appear after existing non-conflicting
     *     entries.
     *   - Notes: union, dedup exact-match; imported notes appended.
     *
     * Rejects on malformed JSON, on shape violations (empty `from` /
     * `to`, malformed `requiresContext`, non-array fields), or on
     * I/O errors. The current on-disk file is never overwritten on
     * a validation failure, so a bad import doesn't corrupt the
     * scope's existing content.
     */
    importVocabulary(scopeId: string): Promise<VocabularyFileDTO | null>;
    /**
     * Open a native save dialog and write the scope's vocabulary
     * file to the chosen path. The exported file follows the same
     * JSON schema as the importable shape (whisperHints,
     * replacements with optional requiresContext, optional notes,
     * plus the metadata $description and $version preserved from
     * the on-disk file). Returns the chosen absolute path on
     * success, or null if the user cancels the dialog.
     *
     * The export path is independent of where the scope is read /
     * written by the app — main writes a fresh file at the user's
     * chosen path; nothing in the live scope changes. This is
     * specifically a "share / back up" affordance, not a save.
     *
     * Rejects on I/O errors (permissions, full disk).
     */
    exportVocabulary(scopeId: string): Promise<{ path: string } | null>;
    /**
     * Save the General section. Currently this is just
     * `audioRetentionDays`; tri-state semantics are described on
     * the GeneralDTO. Rejects on a malformed payload (e.g.
     * non-integer days). The audio sweep runs on a 24h cadence
     * (and at app startup); a save here updates the value the
     * next sweep will use — it does not trigger an immediate
     * sweep.
     */
    saveGeneral(payload: SaveGeneralPayload): Promise<void>;
    /**
     * Save the Performance section (Ollama model + keepAlive +
     * Whisper model). In-flight pipeline steps keep the values
     * they started with; new values apply to subsequent runs.
     * Rejects on empty/unknown values. The Ollama model is not
     * pre-flighted at save time — the user is allowed to set a
     * not-yet-pulled model and pull it from the terminal
     * afterwards; the pipeline raises a clean error if the model
     * is missing at summarise time.
     */
    savePerformance(payload: SavePerformancePayload): Promise<void>;
    /**
     * List the Ollama models currently installed locally, with
     * sizes (bytes). Used to populate the model picker in the
     * Performance pane. Returns a tagged result so the UI can
     * distinguish "Ollama is fine but no models pulled" from
     * "Ollama is unreachable".
     */
    listOllamaModels(): Promise<OllamaModelsResult>;
    /**
     * Show the native folder picker anchored to the current window.
     * Returns null if the user cancels, otherwise the chosen absolute
     * path. Used by the Settings UI for "Browse…" buttons next to each
     * file output directory.
     */
    browseFolder(currentPath: string | null): Promise<string | null>;
  };

  sources: {
    /**
     * Sign in to Plaud with email + password. Persists credentials
     * (password to macOS Keychain) and performs a live login() call
     * to verify them. Rejects with a user-readable message on bad
     * credentials, network errors, or Keychain failures. Returns
     * the new account status on success so the UI can refresh
     * without a separate getStatus call.
     */
    signInPlaud(payload: PlaudSignInPayload): Promise<PlaudAccountStatus>;
    /**
     * Sign out of Plaud: clear credentials (Keychain entry deleted)
     * and the cached JWT. Idempotent — safe to call when not signed
     * in. After this, the poller and pipeline will start failing
     * with 'Plaud not signed in' until a fresh signInPlaud.
     */
    signOutPlaud(): Promise<void>;
    /**
     * Read the current Plaud account status without performing a
     * network round-trip. Returns the email + region from the
     * stored credentials, or { signedIn: false }.
     */
    getPlaudStatus(): Promise<PlaudAccountStatus>;
  };

  app: {
    /**
     * Open (or focus) the Settings window. Optional `tab` selects a
     * specific tab on open — used by the inbox "Sign in again" button
     * to drop the user straight onto Sources rather than relying on
     * Settings's first-tab default. The selection is signalled via
     * the URL hash (#sources etc.) which Settings.tsx reads on mount.
     */
    openSettings(opts?: { tab?: SettingsTab }): Promise<void>;
    /**
     * Read the current tip-jar status. Cheap; the inbox calls this on
     * mount and again whenever the inbox-changed broadcast fires (a
     * new completion may have just bumped the counter past the
     * threshold). Returns the count, the dismissed/notified sticky
     * flags, the derived `shouldShowBanner` boolean, and the URL +
     * threshold the renderer needs for wording.
     */
    getTipJarStatus(): Promise<TipJarStatusDTO>;
    /**
     * Mark the inbox tip-jar banner as dismissed. Sticky — never
     * un-dismissed via this API. The renderer should hide the banner
     * locally as soon as it calls this, without waiting for the
     * round-trip; the next getTipJarStatus call will agree.
     */
    dismissTipJarBanner(): Promise<void>;
    /**
     * Open the tip-jar URL in the user's default browser. Used by
     * the inbox banner button, the tray menu item, and the Settings
     * About-pane link — routed through main rather than
     * window.open() so the URL constant lives in exactly one place.
     */
    openTipJar(): Promise<void>;
  };

  setup: {
    /**
     * Read the initial status the setup window should render. Always
     * succeeds — the main process only opens the setup window when
     * status is 'needs-setup' or 'python-missing', so this call is
     * really a way for the renderer to retrieve the discriminator and
     * supporting context (which path Python lives at, why the venv
     * isn't usable, what tried-paths we report on the missing-Python
     * screen).
     */
    getStatus(): Promise<SetupInitialStatus>;
    /**
     * Begin the install. Returns when the install finishes (either
     * way) so the renderer can await it for an absolute completion
     * signal. Live progress arrives via onSetupProgress; the resolved
     * value is the final outcome.
     */
    start(): Promise<{ kind: 'success' } | { kind: 'failed'; phase: SetupPhase; message: string } | { kind: 'cancelled' }>;
    /**
     * User clicked Quit on the python-missing screen, or Cancel
     * during install. Quits the app cleanly. The python-missing
     * branch is the canonical use — there's no path forward without
     * Python 3.11 installed, and bouncing the user back into a
     * non-functional main app would be worse than quitting.
     */
    quit(): Promise<void>;
  };

  onInboxChanged(handler: () => void): () => void;
  onFocusRecording(handler: (recordingId: string) => void): () => void;
  /**
   * Subscribe to progress events for in-flight local imports. Each
   * event carries the source path (so the renderer can match it to
   * the queue row) plus the current phase and a 0-100 percent (or
   * null when indeterminate, e.g. ffmpeg extraction without a known
   * duration). Returns an unsubscribe function.
   *
   * Note: progress events are broadcast to every open BrowserWindow,
   * matching the existing `inboxChanged` pattern. The renderer must
   * filter by source path itself so that a tag-sheet window opening
   * mid-import doesn't get confused.
   */
  onLocalImportProgress(handler: (p: LocalImportProgressEvent) => void): () => void;

  /**
   * Subscribe to setup-window progress events. Pushed from the main
   * process during the first-launch venv install: phase transitions,
   * streamed log lines, and a terminal 'done' / 'failed' event. The
   * setup renderer is the only consumer; other windows ignore it.
   * Returns an unsubscribe function.
   */
  onSetupProgress(handler: (e: SetupProgressEvent) => void): () => void;
}

/**
 * Wire-format progress event for an in-flight local import. Pushed
 * from the main process every ~200ms while a copy or extract is
 * running, plus phase-transition pings (probe, finalise) that carry
 * a null percent.
 */
export interface LocalImportProgressEvent {
  /** Absolute path of the source file. Renderer keys queue rows by this. */
  sourcePath: string;
  phase: 'probe' | 'copy' | 'extract' | 'finalise';
  /** 0-100, or null when indeterminate. */
  percent: number | null;
}

// ---------------------------------------------------------------------------
// Setup window DTOs. The setup window runs the first-launch Python
// venv install. Three states the renderer can be in:
//
//   - 'needs-setup': system Python 3.11 found, venv is missing /
//     broken / incomplete. Show the friendly explainer + Install
//     button.
//   - 'python-missing': system Python 3.11 not found. Show the
//     brew-install instructions + Quit button. No retry path; the
//     user has to install Python and re-launch.
//   - 'installing': install is running. Show progress bar, phase
//     label, and live log textarea.
//   - 'failed': install failed. Show the failure phase, the error
//     tail, and Retry / Quit buttons.
//   - 'done': install succeeded. The setup window closes itself and
//     main proceeds with normal app start.
//
// State transitions are renderer-side; main only pushes progress
// events and surfaces the initial status via `setup.getStatus`.
// ---------------------------------------------------------------------------

export type SetupInitialStatus =
  | {
      kind: 'needs-setup';
      systemPython: string;
      systemPythonVersion: string;
      /**
       * Human-readable summary of why the venv isn't already ready.
       * Used for the diagnostic small text under the main heading
       * ("venv not yet installed" vs "venv exists but mlx_whisper
       * import failed"), not as a primary error message.
       */
      reason: string;
    }
  | {
      kind: 'python-missing';
      /**
       * The paths the detector tried. Surfaced in the body so the
       * user can see we're not silently ignoring a Python install
       * they have in some weird location.
       */
      triedPaths: string[];
    };

export type SetupPhase = 'creating-venv' | 'installing-packages' | 'verifying';

export interface SetupProgressEvent {
  /**
   * Tagged so the renderer can fan out: 'phase' bumps the progress
   * bar segment and label; 'log' appends a streamed line to the log
   * textarea; 'done' transitions to the success state and the
   * window closes itself; 'failed' transitions to the failure state.
   */
  kind: 'phase' | 'log' | 'done' | 'failed';
  phase?: SetupPhase;
  /** For kind='log'. */
  log?: { stream: 'stdout' | 'stderr'; text: string };
  /** For kind='failed'. */
  failure?: { phase: SetupPhase; message: string };
}

// ---------------------------------------------------------------------------
// Sources DTOs. The Sources pane is list-shaped from day one even
// though Plaud is the only entry today — future sources (other
// recorders, Otter / Fathom imports, etc.) slot in as additional
// entries without needing a UI rewrite.
//
// Each source is either signed in (with account info) or signed out.
// Signed-in entries surface the email and region the user signed in
// with, plus a JWT-expiry timestamp where applicable. The renderer
// uses this to show "Signed in as foo@bar.com" and a Sign Out button.
// ---------------------------------------------------------------------------

export type PlaudAccountStatus =
  | { signedIn: false }
  | {
      signedIn: true;
      email: string;
      region: 'us' | 'eu';
      /**
       * JWT expiry, epoch ms, or null if no token cached yet (e.g.
       * sign-in just happened and the next API call will populate it).
       * The UI surfaces this so the user can see roughly when re-auth
       * will happen — the underlying refresh is automatic, see
       * @plaud/core's PlaudAuth.
       */
      tokenExpiresAt: number | null;
    };

export interface SourcesDTO {
  /** Plaud is the first source. Always present in the list. */
  plaud: PlaudAccountStatus;
}

export interface PlaudSignInPayload {
  email: string;
  password: string;
  region: 'us' | 'eu';
}

/**
 * Snapshot of tip-jar state passed across the IPC boundary. Mirrors
 * `TipJarStatus` in main/tipJar.ts; defined separately here because
 * the main module isn't reachable from the renderer.
 */
export interface TipJarStatusDTO {
  /** Number of summaries completed since this install was created. */
  completionCount: number;
  /** Whether the inbox banner has been dismissed (sticky). */
  bannerDismissed: boolean;
  /** Whether the threshold tray notification has fired (sticky). */
  thresholdNotified: boolean;
  /** True iff the banner should be shown right now. */
  shouldShowBanner: boolean;
  /** Tip-jar URL. Lets the renderer label the link clearly. */
  url: string;
  /** Threshold value, surfaced for wording ("You've completed 50 summaries…"). */
  threshold: number;
}

/**
 * Tab identifiers for the Settings window. Used by
 * `app.openSettings({ tab })` to select an initial tab. Renderer-side,
 * the same union type is the source of truth in `Settings.tsx`. Kept
 * here in the contract because the IPC channel needs to validate the
 * value at the main-process boundary.
 */
export type SettingsTab =
  | 'sources'
  | 'outputs'
  | 'prompts'
  | 'vocabulary'
  | 'general'
  | 'performance'
  | 'about';

export const Channels = {
  InboxList: 'inbox.list',
  InboxSkip: 'inbox.skip',
  InboxRevealInFinder: 'inbox.revealInFinder',
  PipelineCancel: 'pipeline.cancel',
  PipelineRetry: 'pipeline.retry',
  TagSave: 'tag.save',
  TagOpenSheet: 'tag.open-sheet',
  ClientsList: 'clients.list',
  ClientsAdd: 'clients.add',
  MeetingTypesList: 'meetingTypes.list',
  MeetingTypesAdd: 'meetingTypes.add',
  MeetingTypesDelete: 'meetingTypes.delete',
  LocalImportPath: 'localImport.path',
  LocalImportPickFiles: 'localImport.pickFiles',
  PushLocalImportProgress: 'push:local-import-progress',
  SettingsLoad: 'settings.load',
  SettingsSaveOutputs: 'settings.saveOutputs',
  SettingsSavePrompt: 'settings.savePrompt',
  SettingsRevertPromptToBuiltin: 'settings.revertPromptToBuiltin',
  SettingsImportPrompts: 'settings.importPrompts',
  SettingsLoadVocabulary: 'settings.loadVocabulary',
  SettingsSaveVocabulary: 'settings.saveVocabulary',
  SettingsImportVocabulary: 'settings.importVocabulary',
  SettingsExportVocabulary: 'settings.exportVocabulary',
  SettingsSaveGeneral: 'settings.saveGeneral',
  SettingsSavePerformance: 'settings.savePerformance',
  SettingsListOllamaModels: 'settings.listOllamaModels',
  SettingsBrowseFolder: 'settings.browseFolder',
  SourcesPlaudSignIn: 'sources.plaudSignIn',
  SourcesPlaudSignOut: 'sources.plaudSignOut',
  SourcesPlaudStatus: 'sources.plaudStatus',
  AppOpenSettings: 'app.openSettings',
  AppGetTipJarStatus: 'app.getTipJarStatus',
  AppDismissTipJarBanner: 'app.dismissTipJarBanner',
  AppOpenTipJar: 'app.openTipJar',
  SetupGetStatus: 'setup.getStatus',
  SetupStart: 'setup.start',
  SetupQuit: 'setup.quit',
  PushSetupProgress: 'push:setup-progress',
  PushInboxChanged: 'push:inbox-changed',
  PushFocusRecording: 'push:focus-recording',
} as const;

declare global {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    distill: DistillApi;
  }
}
