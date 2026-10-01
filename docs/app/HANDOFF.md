# Development handoff — 2026-09-30

## Base branch — read first

`consolidate/main` is the single source of truth until it is merged to
GitHub `main`. It is built from the other Mac's real history
(`~/dev/distill`, rescued 2026-09-30 as `rescue/Si-Macbook-Pro-…-1-main`):
0.0.17–0.0.20 as originally committed, plus the optional Parakeet engine
and the VAD-with-ffmpeg fix (149be1d). Replayed on top: the 0.0.21–0.0.23
fixes (full Plaud history + backfill, `think: false`, 60s startup import
check, Homebrew PATH, tag-sheet suggestions), search, reader and client
brief, and the other Mac's uncommitted backlog notes and error-message
work. The earlier `recover/v0.0.20` / `integrate/search-reader` branches
were a reconstruction of 0.0.17–0.0.20 from the compiled app and are
superseded. Checks: typecheck, 201 tests, production build.

Note: builds 0.0.22/0.0.23 from the old branches found ffmpeg (PATH fix)
without the 149be1d fix, so VAD was likely off in them. Builds from this
branch have both.

Both Macs are moving to fresh clones in `~/Developer/distill`, outside
iCloud (scripts in iCloud Drive/distill-migration). Develop with Node 22
(`.nvmrc`); Node 26 breaks better-sqlite3 and electron-rebuild's CLI.
Launching the app from a VS Code terminal needs
`env -u ELECTRON_RUN_AS_NODE open …`.

## Intent and workflow

The user wants personal-use improvements, with no commercialisation work.
Inference stays local. The user explicitly requested natural-language
search with summaries as the default and transcripts as an optional next
search. Close each development step with checks, its own commit, and an
updated handoff so Claude can continue without reconstructing the chat.

Read `CLAUDE.md` for project constraints. Existing phase documents are
historical; this file describes the current work.

## Step 1 — local meeting search: complete in source

Commit: `40187ce` — `feat(search): add local summary-first natural-language meeting search`.

- Search box in the inbox; Enter and the primary button search summaries.
- Explicit **Search available transcripts** after summary results, even
  when there are no matches. No automatic transcript search or transcription.
- Local Ollama produces schema-constrained groups of required concepts
  and synonyms. Only the query goes to the model, not recording content.
- Visible exact-keyword fallback on interpretation failure; loopback/local
  inference guard; whole-term matching to avoid DR matching “address”.
- Includes hidden library rows and known Markdown exports. Missing source
  content is counted; results contain excerpts and source labels.
- Retain results by source for the current question. Editing/clearing it
  resets results; explicit summary submission refreshes them.
- Retrieval is phrase matching after language interpretation, not an
  embedding index, date-filter parser, or generated answer across meetings.

Main files: `main/meetingSearch.ts`, `main/meetingContent.ts`,
`renderer/inbox/MeetingSearch.tsx`, `shared/search.ts`, plus IPC/preload
wiring and `State.listSearchableJoined()`. Paths are under `packages/app/src`.

Verification: a clean export of the staged checkpoint passed the normal
`npm run typecheck`, `npm test` (105 tests), and `npm run build`, without
excluding files. A browser fixture checked summary → transcript → summary.
Live smoke test used the configured `qwen3.8:27b-mlx` model with synthetic
records: “A call with HSBC that talked about DR” produced
`[["hsbc"],["dr","disaster recovery"]]` and matched only the intended
recording without fallback. No real meeting content was used.

## Step 2 — meeting reader: complete in source

Checkpoint: the commit containing this update, titled
`feat(reader): add a resizable summary and transcript reader`.

- **Read meeting** on completed recordings and **Open summary/transcript**
  on search results open a separate resizable reader. The selected result
  source determines the initial view. Reopening a recording reuses its
  reader window; different recordings can be compared in separate windows.
- Render summary headings, lists, emphasis, tables and task checkboxes.
  Transcript text stays verbatim, including timestamps already present.
- Literal find within the current view, highlights, counts, previous/next,
  Cmd/Ctrl-F, Enter/Shift-Enter; Escape clears find before closing.
- Read from stored text, falling back to a known Markdown export only for
  missing fields. Show the content source, missing-content messages,
  unreadable-export warning, and existing long-meeting coverage warning.
- Embedded HTML is escaped. Markdown links and images render as text;
  the reader does not execute recording markup or fetch remote images.
- This is read-only: no DB migration, content edits, re-summarisation,
  audio playback, or source citation generation was added.

Main files: `main/meetingContent.ts`, `main/windows.ts`, `shared/meeting.ts`,
`renderer/reader/*`, and the IPC/preload bridge. The reader is a fifth
renderer entry in `electron.vite.config.ts`.

Verification: 112 app tests, full node/web typechecks and production build
on a clean staged checkpoint. New tests cover missing exports/transcripts,
source fallback, Markdown structure, unsafe markup, and literal find.
An isolated browser fixture exercised opening a search result, formatted
summary, transcript switching, find counts and next-match navigation.
Native installed-app interaction and packaging were not exercised.

Reader limitations worth retaining:

- Stored DB text takes precedence over exports. Editing an exported note
  does not update stored text or make the reader prefer the edited export.
- Find matches individual rendered text runs; phrases split by Markdown
  emphasis/link boundaries may not match as a continuous phrase.
- Existing transcript timestamps are preserved; the transcription pipeline
  does not yet retain segment timestamps or a VAD-to-original-audio map.

## Workspace caveat

This iCloud working directory already contained untracked numbered copies
such as `src/main/ipc 2.ts`, `src/main/config 2.ts`,
`src/preload/index 2.ts`, and `test/poller.test 2.ts`, as well as
`Whisper Hints /`. Leave these untouched and out of feature commits.
The copies reference missing old modules and break broad TypeScript/test
globs in this working directory. Validate a clean checkpoint copy, or
exclude these known duplicates when checking the active source. Do not
change the production typecheck configuration just to hide them.

Normal checks in a clean checkout, from `packages/app`:

```sh
npm run typecheck
npm test
npm run build
```

Ollama transport tests bind a localhost mock server; a sandbox without
socket access causes unrelated timeouts. Run those checks with localhost
access. Native `better-sqlite3` remains built for Electron; existing tests
avoid opening a real DB from Node.

## Step 3 — client preparation brief: complete in source

Checkpoint: the commit containing this update, titled
`feat(brief): on-demand client preparation brief with cited sources`.

- Tray › **Client brief…** opens a resizable window. Pick a client and a
  period (30/90/182/365 days or all); that client's meetings are listed
  newest first with checkboxes. Meetings without a summary are shown
  disabled. The newest that fit are pre-selected (up to 5).
- Budget: summaries only, never transcripts; at most 8 meetings and
  48,000 characters (~12k tokens) per brief (`shared/brief.ts`). Over
  the limit, Generate is disabled with the reason — nothing is truncated.
- Local Ollama with a JSON schema (`main/clientBrief.ts`): decisions,
  commitments (with owner), questions raised, and suggested questions.
  Meetings are labelled M1… oldest first. Every point must cite labels;
  `parseBrief` drops points with no valid citation and reports the count.
  Commitments are labelled "status not tracked"; suggested questions are
  labelled as the model's inference. The prompt forbids stating whether
  a commitment was completed.
- Each citation chip and each source opens that meeting in the reader.
  Copy as Markdown; Cancel (also on window close). Nothing is saved or
  run in the background. Same local-host/cloud-model guard as search,
  now shared in `main/localInference.ts`.

Verification: 173 tests (new `clientBrief.test.ts` covers selection
limits, M-numbering, citation validation/dropping, the local-only
guard and Markdown labels), both typechecks, production build. Live
smoke test with `qwen3.8:27b-mlx` on three synthetic summaries: 20–39 s,
all points correctly cited, commitments with owners and no status
claims, nothing dropped. The built window was rendered in headless
Chrome against a stubbed API (picker and result). Not exercised: the
window inside the installed app, and real client meetings.

Limitations: the brief is not saved (copy it if needed); each point
cites whole meetings, not passages; no carry-over between briefs.

## Step 4 — confirmed action/decision register: complete in source

Checkpoint: the commit containing this update, titled
`feat(register): add a confirmed action/decision register`.

- Tray → **Client register…** opens a resizable window: pick a client,
  see its actions (filterable open/done/all) and decisions, newest first.
- Two entry points add a confirmed item, both calling the same
  `register.add` IPC handler — nothing is ever added automatically:
  - **Client brief window**: an "Add to register" button on each
    decision and commitment. A point citing several meetings still
    attaches to a single source meeting — the first one it cites.
  - **Meeting reader**: an "Add to register…" toggle reveals a small
    manual form (kind, text, and for actions an optional owner/due
    date), attributed to that reader's own recording. Hidden when the
    recording has no client (nothing to attribute the item to).
- Actions have an open/done state the user sets from a checkbox in the
  register window; toggling is the only thing that ever changes status.
  Decisions have no status column value at all (DB CHECK constraint
  enforces this) — they're a historical record, not completable.
- Register items are a hard foreign key to their source recording (never
  deleted by this app) and to the client; clicking a source opens it in
  the meeting reader.
- Migration 13 adds `register_items`. Deleting an item is user-initiated
  and confirmed with a native `confirm()` dialog in the register window.

Main files: `shared/register.ts` (types + `checkRegisterAdd`/`isOverdue`,
both pure and tested), `main/state.ts` (migration 13 + CRUD), `main/ipc.ts`
register handlers, `renderer/register/*`, plus edits to
`renderer/brief/main.tsx` and `renderer/reader/MeetingReader.tsx` for the
two entry points, and `shared/meeting.ts`/`main/meetingContent.ts` to add
`clientId` to `MeetingDetail` (needed so the reader knows which client to
attribute a manual entry to).

Verification: 186 tests (10 new, covering `checkRegisterAdd` and
`isOverdue`), both typechecks, production build — all run directly on
this working copy. **Not exercised: the actual window inside a running
app.** `State`'s new SQL methods have no direct test, consistent with
the rest of `state.ts` (see CLAUDE.md's `better-sqlite3` ABI note — this
session's shell was on Node 26, and the project's native module needs
Node 22, so the dev app wasn't launched here). Before relying on this in
real use: run `npm run dev` under Node 22 and click through both entry
points and the register window once.

Limitations worth retaining:

- A brief point that cites multiple meetings only attaches to the first
  one when added to the register — the register's "source meeting" is
  deliberately singular, not a list.
- No decision supersession/versioning: a later, contradicting decision
  is just another row, not linked to or replacing the earlier one.
- No bulk actions (mark several done at once), no edit-in-place (only
  add / toggle status / delete), no export.

## Step 5 — transcript corrections + reusable vocabulary rules: complete in source

Checkpoint: the commit containing this update, titled
`feat(correction): correct a transcript and regenerate its summary`.

- Meeting reader, transcript view, on a finished recording (`complete` or
  `skipped`) with a stored transcript: **Correct a word or phrase…**
  reveals a "Heard as" / "Should be" form.
- Applying it reuses `applyReplacements` from the existing vocabulary
  system (word-boundary aware, case-insensitive) as a single ad-hoc rule
  against `transcript_text`. Zero matches is rejected before anything
  changes. A native confirm dialog names exactly what happens (transcript
  replaced, existing Markdown/HTML/Apple Note deleted, summary
  regenerated, not undoable) before anything runs.
- `State.correctTranscript` sets the corrected text and clears
  `summary_text`/output tracking/error state, then flips status to
  `tagged` — deliberately leaving `transcript_text` and `audio_path`
  alone so `nextNeededStep` resumes at `summarise`, not `transcribe`.
  This is the same short-circuit `InboxSetOutputTargets` already relies
  on for "flip to tagged, let the worker skip finished steps".
- Optional: the same `{from, to}` pair can be saved as a reusable
  vocabulary rule via a scope picker (this client / organisation /
  global), using `addReplacementRule` + the existing
  `readVocabularyFile`/`writeVocabularyFile`. Declining leaves the
  vocabulary files untouched — nothing is remembered by default.
- Correction is unavailable (button hidden) while a recording is still
  processing, or when the reader is only showing a Markdown-fallback
  transcript — there is no stored `transcript_text` to write back to in
  that case. `MeetingDetail.canCorrect` encodes both conditions.

Main files: `main/vocabulary.ts` (`addReplacementRule`, new pure/tested),
`main/state.ts` (`correctTranscript`), `main/ipc.ts`
(`Channels.MeetingCorrect`), `shared/meeting.ts` (`canCorrect`),
`main/meetingContent.ts`, `renderer/reader/MeetingReader.tsx`
(`CorrectionForm`).

Verification: 190 tests (4 new: `addReplacementRule` behaviour and
`canCorrect` gating), both typechecks, production build. **Not
exercised: the actual window/dialog inside a running app** — same
Node-version constraint noted in Step 4 applied again this session.
Before relying on this in real use: run `npm run dev` under Node 22,
correct a real mistranscribed name, and confirm the recording actually
re-summarises without re-transcribing (check the inbox step it resumes
at) and that a saved vocabulary rule shows up in Settings → Vocabulary.

Limitations worth retaining:

- One correction per action — no batch/multi-term corrections in one
  step. Repeat the action for a second phrase.
- The correction does not touch `summary_text` directly (it's cleared
  and regenerated instead), so a mistake that only appears in an
  already-written summary and nowhere in the transcript can't be fixed
  this way — correct the transcript, or wait for the new summary.
- No undo. The confirm dialog is the only safety net; there is no
  version history of transcript text (see "versioned re-summarisation"
  below, which is a different, larger feature: keeping *summary*
  versions side by side, not undoing a transcript edit).
- This is not Stage 3 from BACKLOG.md (an LLM-driven pass proposing its
  own corrections from context) — this is manual, one rule at a time.
  Stage 3 could eventually generate the `{from, to}` pairs this feature
  now knows how to apply and offer to remember.

## Step 6 — Essence branding: complete in source

Checkpoint: the commit containing this update, titled
`feat(branding): incorporate the Essence logo pack`.

Source: an externally-produced "Essence asset pack" (v1.1) — an editable
amber-drop-with-quotation-marks mark, supplied as a full pack (React
component, CSS, PNG/SVG/ICNS assets, a starting activity resolver, and
its own README/IMPLEMENTATION/VALIDATION docs) via
`~/Library/Mobile Documents/com~apple~CloudDocs/distill-essence-assets-v1-1`
— an iCloud path, but only the pack lived there, not this repo; nothing
was run from or referenced against that directory at runtime. Only the
files actually wired up were copied into the repo; the rest of the pack
(design/, tools/, reference/, preview.html, the wordmark SVG, per-state
Dock PNGs, the raw colour/black/white master SVGs) was deliberately not
copied in — no current UI slot uses them. Re-copy from the pack's
`assets/`/`src/` if a future step needs them.

- **Tray icon** (`main/tray.ts`): `resources/icons/trayTemplate*.png`
  etc. (a plain microphone glyph) replaced by the pack's six
  `Essence*Template.png`/`@2x` files — five wired up (idle, waiting,
  active, paused, error), one copied but currently unused (complete;
  see limitations). All are black/alpha templates now, so
  `setTemplateImage(true)` applies unconditionally, unlike the old
  scheme where only `idle` was a template and the rest were
  pre-coloured. `TrayState` gained `'waiting'` as a real icon state
  (previously only reflected in the tray title's digit, not the glyph)
  and `'processing'` was renamed `'active'` to match the asset
  filenames. `computeTrayState`'s precedence — error > paused > active >
  waiting > idle — matches the asset pack's own stated precedence minus
  the completion step. The tooltip now updates every rebuild (not just
  on an icon change) so the specific phase behind a steady "active"
  glyph is still visible on hover, reusing the existing
  `humanProcessingLabel`.
- **App bundle icon**: `build/icon.icns` (the pack's `Distill.icns`,
  1024×1024, PNG-backed per the pack's own `VALIDATION.md` — its
  `iconutil` step failed in the pack's build environment, so the icns
  was written directly from PNG payloads instead of a full multi-size
  iconset). `electron-builder.yml`'s `mac.icon` now points at it,
  replacing the "we don't ship a custom icon yet" comment. This is the
  Finder/Get Info/installer icon only — unrelated to the tray or Dock
  NativeImages at runtime.
- **In-app logo** (`renderer/essence/`): `EssenceLogo.tsx`, `essence.css`
  and `tokens.ts` copied from the pack largely as-is (generic, no
  repo-specific coupling). `activity.ts` was NOT copied verbatim — its
  placeholder `phase` union was rewritten against real
  `InboxItemDTO['status']` values (`shared/register.ts`-style pure
  function + a thin DTO-mapping function, `resolveEssenceActivity` /
  `signalsFromInbox`), and a new `useEssenceActivity.ts` hook (not from
  the pack) tracks a row transitioning into `'complete'` across
  `inbox.list()` refreshes to drive the one-shot 1.8s completion pulse,
  expiring it with a timer the same way the pack's own `StatusExample.tsx`
  demo does. Mounted in the Inbox window header (`renderer/inbox/main.tsx`),
  22px, `decorative` (the "Inbox" text label stays, satisfying "keep
  visible labels"). No new IPC: everything is derived from the window's
  own already-fetched recordings list.

Verification: 197 tests (7 new: `resolveEssenceActivity` precedence
including the completion-TTL boundary, and `signalsFromInbox`'s
derivation), both typechecks, production build (`essence.css` correctly
bundled into the inbox chunk's CSS output). **Not exercised: the actual
tray icon, app icon, or in-app logo inside a running/packaged app** —
same Node-version constraint as Steps 4–5 (this session stayed on Node
26; the project's native modules need Node 22). `npm run package` was
not attempted either, for the same reason plus the fact that packaging
signs nothing and installs into `/Applications` — not something to do
speculatively. Before trusting this in real use: `npm run dev` under
Node 22 and watch the tray icon change through at least one real
download/transcribe/summarise cycle, one paused state, and one error;
open the Inbox and confirm the header logo's colour matches; and after
`npm run package`, check Finder/Get Info shows the new app icon.

Limitations worth retaining:

- **No native Dock icon switching.** The app calls `app.dock?.hide()` at
  startup (`main/index.ts`) — there is no persistent Dock icon to
  switch at runtime, so the pack's `electron/native-status.ts` Dock-image
  example was not adapted or wired up. Per-state Dock PNGs were not
  copied into the repo for the same reason (see the pack's own
  `assets/app/*-512.png` if this ever changes).
- **No tray-level completion pulse.** `EssenceCompleteTemplate.png`/`@2x`
  were copied but nothing in `tray.ts` uses them yet. Detecting "a
  recording just finished successfully" reliably from `tray.ts`'s own
  polling would need new signal plumbing from the worker/pipeline
  completion path (not just tray.ts) — a real code change to
  higher-risk, currently-untested code (see CLAUDE.md's "Where the
  risk is" — `ipc.ts` and by extension the worker it wires up). The
  in-app logo *does* get this pulse, from the Inbox window's own
  higher-fidelity, lower-risk signal (diffing its own polled list).
- **No `paused` activity in the in-app logo.** The Inbox renderer has no
  IPC channel exposing pause state today; `resolveEssenceActivity`
  structurally supports `'paused'` (used by the tray, which does have
  the signal) but the in-app resolver never produces it rather than
  guessing. Adding this would need a new `Settings`/`app`-style IPC
  channel plus a push event for live updates when pause is toggled from
  the tray menu while the Inbox window is open.
- Wordmark, wordmark lockups, and an About/Settings-window use of the
  logo were not added — no such screen currently exists to put one in.

## Step 7 — versioned re-summarisation and comparison: complete in source

Checkpoint: the commit containing this update, titled
`feat(summary-versions): try alternative summaries and keep one`.

- Meeting reader, summary view, on a finished recording with a stored
  transcript (same `canCorrect` gate as Step 5's correction, reused as-is
  since both need the same precondition): **Versions…** reveals a panel
  listing every summary this recording has ever had, newest first, each
  labelled with the meeting-type prompt used and the model.
- **Generate an alternative**: pick a (optionally different) meeting
  type and Ollama model, run it against the same stored transcript. This
  never touches the live `recordings.summary_text` or any output —
  purely additive, logged as an inactive version. A token-budget check
  (reusing `estimateTokenBudget`, same as the main pipeline) surfaces a
  warning rather than blocking.
- **Keep this version**: `State.activateSummaryVersion` copies the
  chosen version's text/model/prompt onto the recording row, clears only
  output tracking (`*_written_at`, `markdown_path`/`html_path`/
  `apple_note_id`) and flips status to `tagged` — `transcript_text` is
  untouched, so `nextNeededStep` resumes at `write`, not `summarise` or
  `transcribe`. Only legal from `complete`/`skipped`.
- Every summary the normal pipeline produces — including one triggered
  by a Step 5 correction — is now logged as an active version
  automatically (`doSummarise` calls `State.addSummaryVersion` right
  after writing the row). Recordings summarised before this migration
  have no logged history; `buildVersionList` synthesises their existing
  summary as a "Current" entry at read time rather than backfilling —
  the same choice this project already made for `original_prompt_hash`
  (see BACKLOG.md).

Main files: `main/summaryVersions.ts` (`generateSummaryVersion`,
`buildVersionList`, both pure/tested), `shared/summaryVersion.ts` (DTO),
`main/state.ts` (migration 14, `addSummaryVersion`,
`activateSummaryVersion`, `listSummaryVersions`), `main/pipelineSteps.ts`
(one added call in `doSummarise`), `main/ipc.ts`
(`Channels.SummaryVersions*`), `renderer/reader/MeetingReader.tsx`
(`VersionsPanel`), `shared/meeting.ts`/`main/meetingContent.ts`
(`meetingTypeId`, for defaulting the picker to the recording's own type).

Verification: 205 tests (8 new: `buildVersionList`'s reconciliation
logic including the synthesised-current and stale-active-row cases, and
`generateSummaryVersion`'s local-inference guard, budget warning, and
empty-response rejection), both typechecks, production build. **Not
exercised: the actual reader panel inside a running app** — same
Node-version constraint as every prior step this session; `npm run dev`
under Node 22 is still the way to confirm the model/meeting-type pickers
populate correctly and that "Keep this version" actually triggers a
re-write in the inbox.

Limitations worth retaining:

- No side-by-side diff view — versions list sequentially with an
  expand/collapse for each one's full text, not a two-pane comparison.
  The spec language ("show the versions side by side") is satisfied
  loosely; a true diff view is a larger follow-on if it turns out to
  matter in practice.
- No cap or cleanup on version history — every summarise run adds a row
  forever. Low-cost today (summaries are small text blobs) but worth
  a retention policy if this ever becomes a real volume of data.
- "Generate an alternative" always re-sends the full transcript (plus
  attendee roster) to Ollama — there's no cheaper "just re-run with a
  different temperature" path, matching how the main pipeline itself
  always re-summarises from the full transcript.
- Activating a version while the recording is mid-pipeline (not
  `complete`/`skipped`) is refused outright rather than queued — the
  version stays logged and can be activated once processing finishes.

## Step 8 — adaptive context sizing: complete in source

Checkpoint: the commit containing this update, titled
`feat(ollama): size the context window to each transcript`.

Came out of asking whether long-meeting chunking (item 7 from the
original ten-item scope) was worth building. It wasn't reconsidered:
split-and-remerge was already proposed and rejected once, documented in
BACKLOG.md's "Truncation guard" entry, on the grounds that the
bump-to-64k-and-warn fix was cheap and good enough. The follow-up
question — would raising the ceiling further help — has a real but
narrow answer: yes for the rare meeting that exceeds it, but
`contextWindow` is one global number, so raising it raises the KV-cache
memory cost of *every* summarise call, including a 10-minute one, not
just the long ones. That's the same class of problem as the 27B-on-24GB
swapping incident CLAUDE.md already documents (model size isn't the
constraint; headroom is).

What shipped instead is narrower than either option: size `num_ctx` to
what each call actually needs, capped at the existing `contextWindow`
ceiling, rather than raising that ceiling at all.

- `main/tokenBudget.ts`: `computeAdaptiveContextWindow(estimatedInputTokens, ceiling)`
  — rounds up to a 4096-token step (so nearby transcript lengths
  converge on one value instead of each provoking a distinct Ollama
  reallocation), floors at 8192, caps at `ceiling`. Pure, tested.
- `OllamaConfig.adaptiveContextWindow: boolean` (default `true`).
  `contextWindow` itself is never rewritten either way — this only
  changes which `num_ctx` value a given call sends. Settings →
  Performance → "Size context to each meeting" toggles it; turning it
  off restores the exact old behaviour (`num_ctx` always equals
  `contextWindow`).
- Wired into both places that resummarise a full transcript:
  `pipelineSteps.ts`'s `doSummarise` (the normal pipeline) and
  `summaryVersions.ts`'s `generateSummaryVersion` (Step 7's "generate an
  alternative"). The existing truncation-warning check
  (`estimateTokenBudget`) is unchanged — it already checks against the
  ceiling, and the adaptive value is never larger than the ceiling, so
  the warning still fires at exactly the same point it always did.

Also discussed this session, deliberately **not changed**: making
`temperature` (currently hardcoded default `0`) configurable up to 0.3.
`CLAUDE.md` already documents why 0 is a settled constraint, not an
oversight — at 0.3, four runs of the same transcript agreed on only 18%
of named entities. Exposing a slider up to 0.3 would let that regression
back in by hand. `temperature` is technically still readable from
`config.json` (`cfg.ollama?.temperature ?? 0`, same as before) for
advanced/debugging use, but no Settings UI was added for it, on purpose.

Verification: 216 tests (11 new — `computeAdaptiveContextWindow` and
`estimateTokenBudget`, the latter previously untested despite being
load-bearing for the existing truncation warning; plus
`normaliseConfig`'s new-field default/override/garbage-value handling,
also a previously-untested function), both typechecks, production
build. **Not exercised: the Settings checkbox or an actual varying
`num_ctx` value against a running Ollama server** — same Node-version
verification gap as every step this session; this one is also easy to
confirm indirectly by watching the `numCtx` field now logged alongside
"starting summarisation".

Limitations worth retaining:

- The adaptive value is recomputed fresh per call from the estimated
  token count — there's no caching or reuse across calls, so back-to-back
  summarise runs on similarly-sized transcripts each still go through
  the same cheap arithmetic (not a real cost, just noting it's not
  memoised).
- Only `doSummarise` and `generateSummaryVersion` were touched.
  `clientBrief.ts` also sends a variable-length input (concatenated
  summaries, up to 48,000 chars) using the flat `contextWindow`, but its
  own selection limits already bound it well under the default ceiling
  — left as-is rather than adding adaptive sizing somewhere it wasn't
  asked for and isn't clearly needed.
- No new floor/ceiling configuration beyond the existing `contextWindow`
  — `MIN_ADAPTIVE_CONTEXT` (8192) and the 4096 rounding step are
  constants in `tokenBudget.ts`, not user-configurable. Revisit only if
  real use shows the rounding granularity matters.

## Step 9 — meeting-type suggestion: complete in source

Checkpoint: the commit containing this update, titled
`feat(tag): suggest a meeting type from title, duration and attendees`.

Prompted by asking how to programmatically pick the right meeting-type
template across a mix like daily standups, client calls, quarterly
reviews, strategy calls and topic workshops. The one constraint that
shaped the whole design: **meeting type is chosen at tag time, before
transcription runs** — tagging is literally what queues the pipeline
(`stepPlanFor`/`nextNeededStep` in `state.ts`) — so there is no
transcript yet to classify against. Two options were considered:
delay the meeting-type choice until after transcription (a real pipeline
restructuring — bigger, riskier, not attempted), or reason over
whatever signals already exist before transcription. This ships the
second, cheaper option.

- Tag sheet, meeting-type field: shown as a dismissable "Suggested: X
  (confidence) — reason [Use this]" chip below the dropdown, never
  applied to the actual selection on its own. **Revised mid-session**: the
  first version pre-selected the dropdown automatically (mirroring the
  client suggestion below); flagged immediately as wrong, because a
  silently-wrong auto-selection here means the wrong summarise prompt
  runs with nothing to notice — exactly the "silent degradation" failure
  mode `CLAUDE.md` already warns about. Clicking "Use this" (or just
  picking directly from the dropdown) is what applies a choice and stops
  the suggestion from recomputing itself out from under it.
  `main/meetingTypeSuggestion.ts` itself was unaffected — only how
  `renderer/tag/main.tsx` uses its result changed.
- **The pre-existing client suggestion was retrofitted to match**, at the
  same request: email-domain matching (`suggestClientId` in
  `shared/attendees.ts`, a pure heuristic, unrelated to this step's
  Ollama call) now also only ever shows as a "Use this" chip, never
  auto-selects `selectedClientId`. This is the one piece of this step
  that touches behaviour that predates this session.
- The Ollama-backed suggestion is gated (needs ≥2 meeting types to
  choose between — does nothing with zero or one) and cancellable (each
  new request aborts the previous one, same `Map<webContentsId,
  AbortController>` pattern as briefs/summary-version generations).
- `main/meetingTypeSuggestion.ts`: reasons over recording title,
  duration, selected client (if picked) and pasted attendees (names +
  parsed company) against the user's *own* existing meeting types —
  labelled `T1`, `T2`, … (same brittle-string-matching defence as
  `clientBrief.ts`'s `M1`/`M2` meeting labels) with a ~200-char excerpt
  of each type's own prompt standing in for "what this label means",
  since meeting types have no separate description field and aren't
  seeded by default. Schema-constrained JSON output
  (`{type, confidence, reason}`), temperature 0, local-only
  (`assertLocalInference`). A label outside the supplied set is dropped,
  not guessed at.
- Triggers automatically on tag-sheet load and again whenever attendees
  or the selected client change (not on every keystroke — attendees only
  change via discrete Parse/+ button clicks) — silently degrades on any
  failure, never blocks the Process button.

Main files: `shared/meetingTypeSuggestion.ts` (DTO), `main/meetingTypeSuggestion.ts`
(`buildSuggestionMessages`/`parseSuggestion`/`suggestMeetingType`, all
pure or directly tested), `main/ipc.ts` (`Channels.TagSuggestMeetingType`),
`renderer/tag/main.tsx`.

Verification: 226 tests (10 new, covering label mapping, invalid/missing
JSON, the confidence fallback, the local-inference guard, and the
fewer-than-two-candidates no-op), both typechecks, production build.
**Not exercised: the actual tag sheet against a running Ollama server**
— same Node-version verification gap as every step this session. Before
relying on this in real use: create at least two meeting types with
genuinely different prompts, open the tag sheet on a real inbox item,
and check the suggestion is both populated and sane.

Limitations worth retaining:

- No suggestion at all once transcription finishes — if a summary later
  makes clear the tagged type was wrong, that's a manual re-tag
  (there's no "reclassify from the transcript and re-summarise" action;
  Step 7's Versions panel already covers switching *models*/*prompts*
  post-hoc, but the user still has to notice and pick the right one).
- Quality depends entirely on the recording's title being informative.
  Plaud recordings often carry generic, timestamp-based titles; the
  attendee list and duration carry more of the signal in that case.
- No manual "suggest again" affordance — only automatic re-triggering on
  attendee/client changes. Fine for the normal flow, mildly annoying if
  you want to force a retry after, say, fixing a mis-parsed attendee
  name without changing the list.

## Step 10 — processing schedule (idle/overnight) + urgent override: complete in source

Checkpoint: the commit containing this update, titled
`feat(schedule): idle/overnight processing with an urgent override`.

Item 8 from the original ten-item scope: "offer processing now, when the
Mac is idle, or during a chosen overnight window... allow an urgent
recording to move ahead of the queue... show whether work is waiting,
paused or running, and why." Default behaviour is unchanged — a fresh
or existing config normalises to `mode: 'immediate'`, which is exactly
today's "tag it, it starts" flow.

- `main/processingSchedule.ts`: `evaluateSchedule(schedule, systemIdleSeconds,
  now)` — pure, tested, handles an overnight window crossing midnight
  (`isWithinOvernightWindow`) and treats a malformed time string as
  "never in window" rather than throwing.
- `AppConfig.processingSchedule` (`config.ts`): `mode: 'immediate' |
  'idle' | 'overnight'`, `idleMinutes`, `overnightStart`/`overnightEnd`
  ("HH:MM"). `normaliseProcessingSchedule` is lenient on load (bad
  field → that field's default, not a crash); `assertProcessingSchedule`
  in `ipc.ts` is strict on save (throws), matching this codebase's
  existing lenient-load/strict-save split.
- `recordings.urgent` (migration 15): set at tag time (a checkbox in the
  tag sheet, off by default) or toggled after the fact from a tagged
  row's Inbox card ("Mark urgent"/"Unmark urgent" — only shown while
  still queued; once claimed the worker is already running it, so the
  toggle would be moot). `State.claimNextTagged` gained a `urgentOnly`
  parameter rather than a new query path.
- `Worker.loop` (`worker.ts`): evaluates the schedule before every claim;
  when blocked, claims only `urgent = 1` rows instead of stopping
  outright. Never touches a step already running — identical in spirit
  to the existing per-step pause, which also only ever gates the *next*
  claim. `PipelineContext` gained an optional `getSystemIdleSeconds`
  getter (same injection pattern as `getConfig`/`ollama`/`plaud`) so
  `worker.ts` and `pipelineSteps.ts` stay Electron-import-free; wired
  from `powerMonitor.getSystemIdleTime()` in `main/index.ts`. A new
  unconditional 60s `setInterval` calls `worker.nudge()` so a window
  opening while the app just sits there (no tag save, no retry, nothing
  else to trigger a check) still gets noticed — cheap, since `nudge()`
  is already a no-op when nothing's claimable.
- **"Why" surface**: the tray tooltip, the status-line menu item, and
  the icon state itself now account for schedule-blocked queued work.
  `main/tray.ts`'s `rebuild()` folds `processing.queued` into the
  existing `waitingCount` input to `computeTrayState` when the schedule
  is blocking and nothing's running, so it shows the existing amber
  "waiting" glyph instead of looking idle — then the tooltip/status text
  say *why* ("Waiting for the Mac to be idle for 15 minutes" / "Waiting
  for the overnight window (22:00–06:00)") instead of the generic "New
  recordings waiting". An urgent row among the queued ones gets claimed
  almost immediately, which moves `running` above 0 and out of this
  branch on its own — no separate urgent-aware branch needed in the tray.
- Settings → General, new "Processing schedule" section: mode select,
  conditional idle-minutes number input or overnight start/end
  `<input type="time">` pair (native time inputs always yield valid
  `HH:MM`, so no client-side format validation was needed).

Main files: `shared/processingSchedule.ts` (DTO types),
`main/processingSchedule.ts`, `main/config.ts`, `main/state.ts`
(migration 15, `setUrgent`, `claimNextTagged`'s new parameter,
`tagRecording`'s new parameter), `main/worker.ts`, `main/pipelineSteps.ts`
(`PipelineContext.getSystemIdleSeconds`), `main/tray.ts`, `main/index.ts`,
`main/ipc.ts` (`Channels.PipelineSetUrgent`, `TagSave`'s new field,
`SettingsSaveGeneral`'s new field), `renderer/settings/panes.tsx`
(`GeneralPane`), `renderer/tag/main.tsx` (urgent checkbox),
`renderer/inbox/main.tsx` (`ProcessingRow`'s urgent toggle).

Verification: 237 tests (11 new — `evaluateSchedule`/
`isWithinOvernightWindow`'s precedence and midnight-crossing behaviour,
and `normaliseProcessingSchedule`'s per-field fallback), both
typechecks, production build. **Not exercised: the actual Settings
pane, tag-sheet checkbox, Inbox urgent toggle, or a real idle/overnight
wait against a running app** — same Node-version gap as every step this
session. `claimNextTagged`'s DB-level behaviour and the worker's own
loop are not directly unit-tested either, consistent with the rest of
`state.ts`/`worker.ts` (see `CLAUDE.md`'s `better-sqlite3` ABI note —
no worker test file existed before this step and none was added, same
as the project's existing limit on what can run under vitest). Before
relying on this in real use: set an idle or overnight schedule, confirm
the tray tooltip explains the wait, mark one recording urgent and
confirm it jumps ahead, and confirm a 60s-old queued state clears once
the window opens without any other action.

Limitations worth retaining:

- **No live "why" text inside the Inbox window itself** — only the tray
  (tooltip + status-line menu item) explains the wait. The Inbox's
  queued-row card just says "Queued · N steps" (plus "Urgent · " when
  applicable) regardless of whether a schedule is holding it back. Fully
  live schedule-status in the Inbox would need a new polled IPC endpoint
  (`inbox.list()`'s existing contract is a plain array, not an object
  with a status field) — deliberately not added this pass to avoid
  changing that contract for every existing caller.
- **No priority ordering beyond binary urgent/not-urgent.** Multiple
  urgent rows still claim oldest-`synced_at`-first, same as normal
  claiming; there's no second-level "most urgent first" ranking.
- **Idle detection is exactly what macOS calls idle** (no keyboard/mouse
  input) — a Mac actively doing something CPU-heavy with no input
  (encoding video, say) still counts as idle. This is `powerMonitor`'s
  own definition, not something this feature adds nuance to.
- **The overnight window is wall-clock local time**, re-evaluated every
  60s; it does not account for the Mac sleeping through part of the
  window (a MacBook asleep from 23:00–05:00 simply never ticks the timer
  during that stretch, so nothing claims until it wakes and the next
  60s tick lands inside the remaining window — not a bug, just a
  consequence of `setInterval` not running during sleep).

## Next step

Later ideas, not implemented or fully specified: diagnostics and
backup/restore (items 9 and 10 from the original ten-item scope).
Source-linked audio is also later work. Decision supersession/versioning
(see the register's limitations above), a tray-level completion pulse
and native Dock switching (see Step 6's limitations), a real
side-by-side diff view or a retention policy for summary versions (see
Step 7's limitations), configurable adaptive-context tuning (see Step
8's limitations), post-transcript reclassification (see Step 9's
limitations), and live in-Inbox schedule status or multi-level priority
(see Step 10's limitations) are optional follow-ons to already-shipped
steps, not required by them. Long-meeting chunking (the original item 7)
remains deliberately un-built — see Step 8 and BACKLOG.md's "Truncation
guard" for why.

No package has been installed or release published as part of this work.
The known unrelated untracked files are intentionally left in the working
directory; the completed feature commits contain none of them.
