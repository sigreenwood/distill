# Design decisions — Prompts & Vocabulary editor

**Status:** Decided Apr 2026. Superseded parts of earlier BACKLOG and
reference docs noted inline.

This document captures three design decisions that gate the Prompts and
Vocabulary editor work. They were made after a full structural code
review (see BACKLOG "Typecheck and test debt" for the review's debt
items) and a focused decisions session. They're recorded here so the
implementation session starts from a known position.

**Scope:** what the decisions are, why, and exactly what to build.
Everything below is normative for the next implementation session.

---

## 1. Fan-out idempotency → per-destination tracking columns

### Problem

`doWriteOutputs` fans out to Markdown, HTML, and Apple Notes in parallel.
The current retry short-circuit is `anyOutputWritten` — if any of the
three output fields on the row is non-null, the write step is skipped
entirely. This produces two real failure modes:

1. **Silent half-complete.** Row where Markdown succeeded, HTML failed
   (disk full), Apple Notes hadn't run. Retry: `markdown_path` is set,
   so `anyOutputWritten` is true, so write step is skipped. HTML and
   Apple Notes never run. Row goes to `complete` with only Markdown.

2. **Duplicate Apple Notes.** Row where Apple Notes succeeded, Markdown
   errored. Retry re-runs everything. Apple Notes creates a duplicate
   note because AppleScript has no upsert primitive.

### Decision

Track per-destination completion with three `INTEGER` timestamp columns.
On retry, only destinations with a null timestamp run.

### Schema — migration 6

```sql
-- State each destination's completion independently so retry only re-runs
-- what hasn't yet succeeded. Without this, retry either redoes everything
-- (producing duplicate Apple Notes and `foo (1).md` Markdown collisions)
-- or shortcircuits if any destination has written (leaving the other
-- destinations never attempted). Timestamps (not booleans) because they
-- are free and let us surface "written 3m ago" in the UI later if useful.
ALTER TABLE recordings ADD COLUMN markdown_written_at   INTEGER;
ALTER TABLE recordings ADD COLUMN html_written_at       INTEGER;
ALTER TABLE recordings ADD COLUMN apple_note_written_at INTEGER;
```

### Code changes

- `RecordingRow` in `state.ts` gains the three columns.
- `setStatus`'s `patch` type accepts `markdown_written_at`, `html_written_at`,
  `apple_note_written_at`.
- `doWriteOutputs` in `pipeline/steps.ts` rewritten:
  1. Read row + live config.
  2. For each enabled destination where `*_written_at` is null, attempt
     the write.
  3. On success, set the corresponding timestamp via `setStatus` patch.
  4. If any enabled destination still has null `*_written_at` at end of
     step, throw a partial-failure error naming which destinations
     failed. Otherwise transition to `complete`.
- `anyOutputWritten` short-circuit deleted — replaced by per-destination
  null checks.
- Writers themselves stay unchanged. `uniquifyPath` stays in the Markdown
  writer as defence in depth but in practice never fires because we do
  not re-call the writer for an already-timestamped destination.

### Retry semantics (new contract)

On retry, the pipeline step starts fresh. `*_written_at` timestamps
persist from the prior attempt. Enabled destinations with null
timestamps run. Two subtle cases worth naming:

- **User disabled a destination after it wrote.** The timestamp stays.
  The destination doesn't run again. The file / note is not deleted.
  This matches user expectations: "I don't want new HTML from now on"
  does not mean "delete existing HTML".
- **User enabled a destination that wasn't in the prior attempt.** Its
  timestamp is null, so it runs on retry. The row ends up with the new
  destination's output alongside any existing ones.

### Hook for later

This schema directly supports a future "Regenerate outputs" action
(BACKLOG item) as: clear the chosen `*_written_at` timestamps on a
completed row → set status to `tagged` → worker picks it up → only
cleared destinations run. No new pipeline step required.

### Tests to add

- Retry when only HTML failed the first time — Markdown and Apple Notes
  timestamps preserved, HTML runs, row goes to `complete`.
- Retry when user has since disabled a destination that had previously
  failed — destination doesn't run, step succeeds if remaining enabled
  destinations are written.
- Retry when user has since enabled a destination that wasn't attempted
  first time — destination runs.

---

## 2. Vocabulary schema → JSON files, in-app editor

### Problem

BACKLOG's older design says `whisper_initial_prompt` column on
`clients` and `meeting_types`, combined at transcribe time. The actual
implementation is JSON files in `packages/app/resources/vocabulary/`,
merged by `loadVocabulary`. The two surfaces disagree; the question is
which to keep.

### Decision

Keep JSON files. Build a Settings pane that edits them in place. Do not
promote vocabulary to database columns.

### Why

- Vocabulary is **curation content**, not per-install state.
  Domain-specific terms belong next to the code — reviewable in PRs, shareable
  between installs via git, portable.
- The BACKLOG's DB-backed design predates the JSON approach. The JSON
  approach was built because it was simpler and works well. Reversing
  that is meaningful work for marginal benefit.
- Meeting-type vocabulary is theoretically nice but probably not what
  users want. Meeting types are about **tone and structure**
  ("summarise as discovery notes" vs "summarise as action items");
  terms are about **client or domain**. The absence of
  meeting-type vocabulary is a deliberate simplification.

### Layout (unchanged)

- `resources/vocabulary/global.json` — always merged
- `resources/vocabulary/organisation.json` — always merged (organisation-wide
  domain terms; was `teradata.json` in earlier shapes, renamed for
  multi-organisation use)
- `resources/vocabulary/industry.json` — always merged (industry / field-wide
  terms; was `ai.json` in earlier shapes, same rename)
- `resources/vocabulary/<client-id>.json` — merged when a recording is
  tagged for that client

File shape stays as today: array of entries, each with `term`,
optional `context`, and an optional `replacements` array. No schema
change to the files themselves.

### IPC additions

```ts
vocabulary: {
  listScopes(): Promise<Array<{ id: string; label: string; builtin: boolean; termCount: number }>>;
  load(scopeId: string): Promise<VocabularyFile>;
  save(scopeId: string, file: VocabularyFile): Promise<void>;
};
```

Where `VocabularyFile` mirrors the JSON shape:

```ts
interface VocabularyTerm {
  term: string;
  context?: string;
  replacements?: Array<{ from: string; to: string; context?: string }>;
}
type VocabularyFile = VocabularyTerm[];
```

### `listScopes` enumerates

- Three built-in packs (`global`, `organisation`, `industry`), marked
  `builtin: true`.
- One entry per existing client, resolved via the client-id → filename
  mapping.
- Creating a new client makes its vocabulary scope available. The file
  doesn't need to exist on disk until first save — `load` on a missing
  file returns an empty array.

No IPC for creating new *built-in* packs from the UI. Those stay
curated in git.

### UI sketch

A "Vocabulary" tab inside Settings. Two-column layout:

- **Left (sidebar):** scope list. Built-in packs grouped at top with a
  small lock icon (not disabled, just a visual cue — the contributor is
  the only user and changes to built-ins still go into the repo).
  Clients below, alphabetical. Term count badge per scope.
- **Right (editor):** table of terms for the selected scope. Columns:
  `Term`, `Context (optional)`, and below the table a `Replacements`
  section listing `from`, `to`, `context` rules that apply when this
  term appears. Add / edit / delete inline. One Save button per-scope.

Per-scope save button (not a global save) to match the per-section save
channels decided in §3.

### Not building

- **`personal.json` / user-scope vocabulary in Application Support.**
  Adds complexity with marginal benefit. One-line extension later if
  the contributor ever wants personal terms separate from curated ones.
- **Per-meeting-type vocabulary.** Deliberate simplification; see Why
  above.
- **Replacement-rule regex support.** Today's word-boundary matching
  handles the realistic cases. Adding regex is a trapdoor for the user.

### What this decision supersedes

The BACKLOG entry:

> Store as a `whisper_initial_prompt` column on `clients` and
> `meeting_types`; combine them when transcribing.

is superseded. Leave the BACKLOG entry in place, add a pointer to this
document.

---

## 3. Settings shape → unified load, per-section save channels

### Problem

Today: one `settings.load()` returning `{outputs}` and one
`settings.save({outputs})`. The Prompts and Vocabulary tabs need to
fit inside the same Settings window without breaking the single-blob
save model's failure isolation.

### Decision

Unified load (one call returns all three sections' data). Per-section
save (three separate save channels). Each tab owns its own dirty-state
and submit handler.

### IPC changes

**Current:**

```ts
settings: {
  load(): Promise<SettingsDTO>;          // { outputs }
  save(payload: SaveSettingsPayload): Promise<void>;
  browseFolder(currentPath: string | null): Promise<string | null>;
};
```

**New:**

```ts
settings: {
  load(): Promise<SettingsDTO>;
  saveOutputs(payload: OutputsDTO): Promise<void>;
  savePrompt(payload: SavePromptPayload): Promise<void>;
  saveVocabulary(payload: SaveVocabularyPayload): Promise<void>;
  browseFolder(currentPath: string | null): Promise<string | null>;
};
```

The existing `save` channel is removed (not deprecated — the Settings
Outputs tab migrates to `saveOutputs` as part of this work, and nothing
else consumes it).

### `SettingsDTO` grows

```ts
interface SettingsDTO {
  outputs: OutputsDTO;
  prompts: MeetingTypeDTO[];
  vocabularyScopes: Array<{
    id: string;
    label: string;
    builtin: boolean;
    termCount: number;
  }>;
}
```

Vocabulary **file contents** load on-demand via `vocabulary.load(scopeId)`
when the user clicks a scope. Keeps the initial `settings.load()` small
even as vocabulary packs grow.

### Why unified load

The Settings window always opens with all three panes mounted. One
call populates all three tabs before the user picks one. Simpler than
three parallel promises on mount. Matches the "Settings is one window
with tabs" mental model.

### Why per-section save

Each tab's save button owns its own dirty state and submit handler.
A vocab JSON write failure doesn't block an outputs save. Each handler
in `ipc.ts` asserts the shape of its own slice and re-normalises only
that slice of config.

This dissolves structural review finding #2 (shallow config merge) as a
concern, because no handler ever touches more than one section at a
time.

### Close / discard behaviour

Standard dirty-state prompt on close if any tab has unsaved changes.
Per-tab dirty tracking lets the prompt say "Outputs tab has unsaved
changes" rather than the less useful generic "settings have unsaved
changes".

### `SavePromptPayload` and `SaveVocabularyPayload`

```ts
interface SavePromptPayload {
  id: string;
  name: string;
  prompt: string;
}

interface SaveVocabularyPayload {
  scopeId: string;
  file: VocabularyFile;
}
```

Vocabulary save payload is identical to `vocabulary.save` — the
duplication is deliberate to keep the Settings IPC surface
self-contained. In practice both channels can share the same handler.

---

## Implementation order for the next session

Doing these in this sequence minimises rework:

1. **Migration 6 + idempotency fix.** Three timestamp columns,
   `doWriteOutputs` rewrite, `RecordingRow` updates, `setStatus` patch
   field additions. Tests for the three retry scenarios. ~1h.
2. **Settings IPC split.** Remove `save`, add `saveOutputs`. Extend
   `SettingsDTO`. Keep the existing Outputs tab working on the new
   channel. ~30m.
3. **Prompts tab.** Build inside `Settings.tsx`. List of meeting types,
   click to expand-edit in place. New IPC channel `settings.savePrompt`.
   Uses existing `meetingTypes.add` / `meetingTypes.list` for add/list,
   new handler for update. Add migration 7 for `original_prompt_hash`
   so the UI can show a "modified from default" badge. ~1.5h.
4. **Vocabulary tab.** Build inside `Settings.tsx`. Scope sidebar, term
   table, replacements table. New IPC channels `vocabulary.listScopes`,
   `.load`, `.save`. Handlers operate on JSON files under
   `resources/vocabulary/`. ~1.5h.

Total: roughly half a day of focused work, plus tests.

---

## Review findings this document resolves

- **#2 shallow config merge** — dissolved by per-section saves (§3).
- **#6 fan-out idempotency** — solved by §1.
- **#12 `MeetingTypeDTO` missing `updated_at`** — landed in the Apr 2026
  mechanical batch.
- **#15 vocabulary schema JSON-vs-DB** — answered (JSON, §2).
- **#16 `SettingsDTO` shape** — answered (unified load, split save, §3).

## Review findings still outstanding

- Typecheck and test debt (seven items) — see BACKLOG.
- Prompts pane's `original_prompt_hash` — covered by step 3 above.
- Tag sheet refresh on meeting-type add (#8) — becomes natural to do in
  step 3 when the push channel exists.

---

## Open questions for the implementation session

None that block starting. A few small choices will want a quick call:

- **Step 3 schema:** does `original_prompt_hash` get set on seed only,
  or also on every `saveSeedPrompt` operation? Probably seed-only,
  matching "the hash of what we originally shipped". Decide when
  building.
- **Step 3 diff UI:** do we show the user the diff between their edit
  and the shipped default, or just flag "modified"? Probably just flag
  for v1, with a "reset to default" button. Decide when building.
- **Step 4 builtin lock icon:** is the icon purely decorative or does
  it prompt a confirmation dialog on edit? Probably confirmation, since
  edits to built-ins change git-tracked files. Decide when building.

These are all five-second calls during implementation, not things that
gate starting.

---

## 4. Title-line prompt convention (Apr 2026, late session)

*Added after the original three decisions; documents a convention
introduced when the filename format work shipped.*

### Convention

Every built-in prompt in PROMPTS.md begins with an explicit
instruction: the model's output MUST start with a single-line
8-10 word descriptive title, in plain text, before any heading or
structured content. The four built-in prompts (`client-call`,
`training`, `all-hands`, `ladffa`) carry this instruction; user-created
prompts can carry it too if the user wants well-named output files.

### Why

Filenames are now `{date} - {client} - {title}` where `title` is
pulled from line 1 of the summary by `extractTitleFromSummary`. If a
prompt drops the line-1-title instruction, summaries silently fall
back to using Plaud's auto-title ("Meeting: Cloud Migration,
Infrastructure Optimization, Disaster Recovery") which is what we
were replacing in the first place. The fallback is a feature for
pre-existing rows and prompts that don't follow the convention, not
a licence to drop the convention.

### Implications for prompt edits

- Editing a built-in prompt and saving keeps the line-1-title
  instruction unless the user explicitly removes it. The Settings
  Prompts pane shows the full prompt text in a textarea; the
  instruction is just a paragraph the user can edit.
- Reverting to default re-applies the convention from PROMPTS.md.
- Custom prompts pasted in by a user (from another LLM, etc.) won't
  have the convention unless the user added it. This is fine; the
  filename will fall back to the Plaud auto-title for those rows.

### Implications for the parser

`extractTitleFromSummary` is defensive about what it accepts as a
title line: rejects bare section headers ("Executive Summary",
"Summary"), rejects numbered openers ("1) ..."), rejects fragments
shorter than three words. Cap at 15 words. These rules are pinned
by tests in `buildFilenameStem.test.ts`. Future prompt convention
changes should keep the parser tests green or update them in
lockstep.

### Not building

- Per-row override of the extracted title. If the user wants a
  different filename, they can rename the file after writing.
- Auto-rerunning summaries when prompts change (re-summarising for
  better titles is way too expensive for marginal benefit).
