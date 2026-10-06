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
iCloud (scripts in iCloud Drive/distill-migration). Develop with Node 26
(`.nvmrc`; engines `>=22.12`). The Node 22 notes in older steps below
predate the 3 Oct dependency upgrade (see "Dependency upgrade").
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

## Step 11 — live Plaud reconnect after sign-in: complete in source

Checkpoint: the commit containing this update, titled
`fix(plaud): reconnect live after sign-in instead of asking for a restart`.

A real bug, not a feature — logged in BACKLOG.md as "hit for real Jul
2026": signing in from Settings → Sources stored the credentials but did
nothing until the app was restarted, because `connect()` throwing
`PlaudNotAuthenticatedError` at startup meant the worker and poller were
never constructed, and nothing ever retried that construction later. The
app's own "restart to apply" toast papered over it, but a brand-new
user's very first action (sign in) silently not working is about the
worst possible first impression.

- `main/index.ts`: the connect/worker/poller block that used to be
  inline in `continueBootstrap()` is now `connectPlaudAndStartPipeline()`
  — idempotent (`if (poller) return true;` up front), so calling it again
  after the pipeline is already running is a safe no-op rather than a
  second poller. `continueBootstrap()` now just calls it once, same as
  before; nothing about the normal (already-authenticated) startup path
  changed.
- New `IpcContext.onPlaudSignedIn` callback (`ipc.ts`), fired only on a
  *successful* sign-in — separate from the pre-existing
  `onPlaudCredentialsChanged`, which now fires on sign-out only (its
  "restart to apply" message was also reworded; it previously said
  "start syncing with the new Plaud account" for a sign-*out*, which
  never made sense). `onPlaudSignedIn` checks whether `poller` already
  exists:
  - If not (the actual bug — never successfully connected before):
    calls `connectPlaudAndStartPipeline()`, clears a stale "Plaud: not
    signed in" tray warning on success, and shows a "signed in, syncing
    started" notification instead of asking for a restart.
  - If a poller already exists (switching to a *different* account while
    already connected): still asks for a restart. The already-running
    worker/poller hold a reference to the old `PlaudClient`; swapping
    that live was judged more risk than this fix was worth, and isn't
    the behaviour BACKLOG.md's entry was actually about.

Main files: `main/index.ts`, `main/ipc.ts`.

Verification: 237 tests (unchanged — this is bootstrap/wiring code with
no dedicated test file, same as before the fix), both typechecks,
production build, **and an actual `npm run dev` launch under Node 22**
confirming the normal already-authenticated startup path still reaches
"Plaud connection ready" / "distill ready" exactly as before. **Not
exercised: the actual sign-out → sign-in reconnect sequence** — doing
that against this session's real, live-connected Plaud account would
mean signing out of someone's real account to test a code path, which
wasn't done without being asked. Before trusting this fully: sign out
from Settings → Sources, confirm the tray shows "Plaud: not signed in"
and the inbox stops polling, then sign back in and confirm a "signed
in, syncing started" notification appears with no restart needed.

Limitations worth retaining:

- Switching to a *different* Plaud account while already connected still
  requires a restart, unchanged from before this fix. Only the
  never-successfully-connected-yet case was fixed, matching BACKLOG's
  own fix shape exactly.
- If `connect()` still fails after a sign-in (e.g. the token isn't
  immediately readable, or some other transient issue), `poller` stays
  null and the user sees the same "sign in needed" treatment as a
  fresh-startup auth failure — there's no distinct "signed in but still
  couldn't connect, here's why" message beyond what the existing catch
  block already logs/notifies.

## Step 12 — "Queue all", classify, then file: complete in source

Checkpoint: the commit containing this update, titled
`feat(filing): queue untagged recordings and confirm the client afterwards`.

- Inbox → Waiting to tag gains **Queue all**. After a confirm dialog,
  every `inbox` row moves to `tagged` with no client or meeting type and
  `needs_filing = 1` (migration 16). The rows follow the processing
  schedule like any other tagged row, so with Overnight mode they run
  overnight.
- Classification runs at the start of the summarise step, only for
  `needs_filing` rows with no meeting type (`classifyForFiling` in
  `pipelineSteps.ts`, built on `main/filingSuggestion.ts`). One local
  Ollama call reads the title, duration and the first 12,000 characters
  of the transcript, against the user's clients (C1…) and meeting types
  (T1…). A JSON schema is used, at temperature 0. The client can be
  "none". The chosen meeting type is stored on the row immediately, so
  the summary uses that type's prompt and a retry does not classify
  again. The client is stored only as `suggested_client_id`, with
  `filing_confidence`/`filing_reason`. An unparseable reply falls back
  to the first meeting type with no client, and the row says so.
- After summarising, the worker holds `needs_filing` rows at the new
  `to_file` status instead of writing. Nothing reaches Markdown, HTML or
  Apple Notes until the user files the row. This matters because Notes
  has no move or upsert, so a wrong folder can only be fixed by
  duplicating the note.
- Inbox → **Ready to file** (shown above Processing) pre-selects the
  suggested client and the meeting type used. It also offers Read
  summary and Hide. **File** sets the client and type, clears
  `needs_filing` and requeues the row. When the type is unchanged, only
  the write step runs. When the type changed, the summary is cleared and
  regenerated from the stored transcript first (`filingNeedsResummary`).
- `claimNextTagged` now lets a row whose next step is `write` through
  even while the schedule blocks normal claims. Filing in the morning
  therefore writes at once, and so does enabling an output on a finished
  row. A re-summary after a type change still waits for the schedule
  unless the row is marked urgent.
- `inboxCount()` (tray digit, Inbox menu label) now counts `to_file`
  too, because those rows are waiting on the user.

Decision recorded in DECISIONS.md §5: "Queue all" is an explicit user
action, so inbox-first holds. Filing stays suggestion-only, with no
auto-file at any confidence for now.

Verification: 273 tests. The new `filingSuggestion.test.ts` covers
labels, transcript truncation, parsing including the no-client and
invalid-type cases, the Ollama request shape, `filingNeedsResummary`
and payload validation. Both typechecks and the production build pass.
**Not exercised: the running app.** This session's shell was on
Node 26 again. Before relying on it: under Node 22, set the schedule to
Overnight with a window starting a few minutes out, press Queue all on
two or three real recordings, and confirm each one:
- reaches Ready to file;
- shows a sensible client suggestion;
- writes into the right client folder when filed;
- when given a different type, re-summarises without re-transcribing.

Limitations worth retaining:

- Client-scoped vocabulary cannot help transcription, because the
  client is unknown until after it. Global and organisation vocabulary
  still apply. Client find-and-replace rules are not re-applied after
  filing.
- No auto-file, even at high confidence. Once suggestions have proved
  reliable, an opt-in threshold would be the next step.
- A client can't be created from the Ready to file row, only chosen.
  Add new clients from the tag sheet or Settings first.
- Classification uses only the opening of the transcript. A meeting
  whose client only comes up late may get "no client".
- No notification when a recording reaches Ready to file. The tray
  digit shows the count.
- Fixed in a follow-up commit (`fix(worker): …`): if a step was paused
  between the claim and that step's own pause check, the worker set the
  row back to `tagged` and then marked it `complete` anyway, with no
  output written. The loop now marks a row `complete` only when it is
  at `writing`, which only a finished write step leaves. Covered by
  `test/worker.test.ts`, the first worker-loop test, which uses an
  in-memory fake State.

## Step 13 — Outlook calendar printouts (PDF): meetings and accounts: complete in source

Checkpoint: the commit containing this update, titled
`feat(calendar): match recordings to meetings and accounts from Outlook calendar PDFs`.

Replaces an abandoned .olm attempt. Outlook for Mac exported only shared
and free/busy calendars, and never finished the archive. The printout
(Outlook on the web → Print → detailed agenda → Save as PDF from Chrome)
carries everything: subject, local times, location, organiser, required
and optional attendees with email addresses, and the invite body.

- **Parsing** (`python/calendar_pdf.py`, run in the app's own venv;
  `pypdf` added to requirements.txt and the startup import check, so an
  existing install goes through the setup window once). The script reads
  text with font sizes and positions. An event is the run of
  subject-sized lines directly above a time line such as
  "Mon 2026-08-03 9:00 AM - 9:30 AM". The subject size is learned per
  document, since print scaling varies. Then come Location / Organiser /
  Required / Optional Attendees, then the body, cut where the
  Teams/Webex dial-in block and the recording notice begin.
  Private-use icon glyphs and zero-width page-break lines are stripped:
  otherwise a subject at the foot of a page separates from its time on
  the next. All-day entries are dropped. Layout rules only, no model.
- **Storage:** migration 17 adds `calendar_meetings` and
  `recordings.calendar_match_json`. Re-importing replaces every meeting
  starting within the imported period. Meeting ids hash date, start and
  subject, so the same event printed in two files is stored once.
- **Matching** (`main/calendar/match.ts`): every real meeting covering at
  least half of the recording, or half of the meeting if it is shorter,
  is a candidate. Cancelled meetings and anything over 8 hours are
  skipped. Personal blocks with no organiser or invitees ("Lunch") count
  only when nothing else is booked. Candidates are ranked by
  overlap ÷ union, and the best is stored with up to 3 `alternatives`.
- **Overlapping meetings** (user's warning, checked on real data). Of
  203 matched recordings, 47 were double-booked, and in 42 of those the
  meetings point to different accounts. Some single recordings ran
  across back-to-back meetings. The first version picked one meeting
  by time fit and mentioned a runner-up only within 80%. That favoured
  shorter meetings and silently chose the account. Now:
  - **Account:** suggested only if *every* candidate points to the same
    account (`accountForMatch`). A candidate with no account counts
    against.
  - **Attendees:** invitees are adopted only from a single, unambiguous
    meeting.
  - **Filing classifier:** sees all candidates as M1…Mn, each with
    invitee domains and its own account. It answers which one the
    transcript matches, or "none" for a call in a booked slot.
    `classifyForFiling` stores the choice as the match
    (`confirmedByTranscript`, or `rejectedByTranscript` for "none"),
    takes that meeting's invitees for the summary roster, and then the
    account.
  - **Tag sheet:** lists the overlapping meetings ("Which was this?",
    plus "Neither") and offers account and invitees only for the chosen
    one. The tag sheet's meeting-type suggestion is told all the
    double-booked titles.
  - **Inbox rows:** show "📅 A — or “B”", with "overlapping meetings,
    account unclear" when they disagree.
  - **Trial** (local model, real transcripts): a 92-minute session
    booked against another account's daily huddle chose the right
    meeting and account. A call previously thought to be "unscheduled
    in another account's slot" turned out to have a third booked
    meeting the old single pick had hidden; the classifier chose it,
    with high confidence.
  - **Result on three months:** calendar account suggestions fell from
    124 to 103, and disagreements with the user's own filing from 3
    to 1.
- **Account** (`main/calendar/account.ts`): keywords come from the
  user's own client names, including the acronym ("Lloyds Banking
  Group" → LBG, Lloyds), so there are no rules to maintain. The meeting
  title scores 3, invitee email domains 2, the invite text 1. A tie
  between clients gives no suggestion, and Unclassified is never
  suggested.
- **Where it shows up (suggestions only):**
  - Inbox → Waiting to tag gains **Import calendar PDFs…** with
    coverage. Rows show 📅 the meeting and its account.
  - Tag sheet: the meeting line, the account as a click-to-apply client
    suggestion (ahead of the domain-history heuristic), and an "Add"
    offer for the invitees. The meeting-type suggestion (local model)
    also gets the calendar title.
  - Queue all: queued rows adopt the invitees as attendees before
    transcription, for Whisper hints and the summary roster. The
    classifier is given the meeting, invitee domains, invite notes and
    account. If the model names no client, the calendar's account
    stands. Ready to file pre-selects it.
  - Manually tagged rows never adopt invitees automatically, because
    the sheet saves exactly what the user kept.

**Checked against real data** (3 printouts, Aug–Oct 2026, 562 pages):
- 519 timed meetings in 10.5 s, with no warnings once the page-break
  fix was in.
- Of 249 Plaud recordings since 3 Aug, 203 match a meeting: 133 start
  within 5 minutes and 19 are ambiguous.
- 124 of the matched get an account: HSBC 68, LBG 36, AIB 20. Only 3
  disagree with how those recordings were already filed. "Check in on
  HSBC and AIB" correctly gets none.

Verification: 287 tests. `calendarPdf.test.ts` covers local-time
conversion, de-duplication, overlap scoring, personal blocks, cancelled
meetings, ambiguity, attendee caps, account keywords/domains/ties and
the classifier prompt. Both typechecks and the production build pass.
The TS import path was run end to end on the three real PDFs (with a
scratch venv). **Not exercised: the running app**, including the setup
window installing pypdf (Node 26 shell again).

Limitations worth retaining:

- Times are read as the Mac's local zone, which assumes the printout
  was made in the same zone as the recordings' Mac.
- The Python parser has no automated test. It was validated on the
  three real printouts only. A different Outlook print layout (classic
  Outlook, another language) would need its time-line pattern adjusted.
- Accounts come from client-name keywords only. Partner domains (e.g.
  Celebrus) and subsidiaries (First Direct for HSBC) don't map unless
  the title names the account.

## Step 14 — suggested meeting types (prompt corpus): complete in source

Checkpoint: the commit containing this update, titled
`feat(prompts): suggest eight meeting types built from real meetings`.

- `resources/prompts/suggested-meeting-types.md` (bundled through the
  existing `resources/prompts` rule) holds eight meeting types:
  account team stand-up, customer status call, customer workshop or deep
  dive, QBR or service review, internal account strategy, team meeting,
  1:1, and enablement or office hours. Each has a `Use for:` line and a
  prompt. The file contains no customer or people names; a test checks
  this.
- Settings → Prompts lists them under **Suggested** in the sidebar.
  Selecting one shows a read-only preview with **Add meeting type**
  (creates an ordinary user meeting type using the suggestion's id) and
  **Dismiss** (stored in `app_state.dismissedPromptSuggestions`).
  Suggestions already present by id or name are hidden. Nothing is
  added without a click.
- **Where the types came from:** three months of the user's calendar
  (519 meetings) and the 44 existing summaries were reviewed. This was
  done with the user's explicit agreement, at development time only. In
  the app, all content handling stays local. Lessons built into every
  prompt:
  - Transcripts have no speaker labels, so owners are named only when
    the transcript names them. Older summaries were full of
    "[Teradata Team]".
  - Internal account meetings are not customer calls. The old Client
    Call prompt gave internal calls a customer sentiment score.
  - Personal and health details are left out. An older summary had
    recorded a colleague's hospital appointment.
  - "(Not stated)" is used instead of guessing.
  - The output starts with a title line (DECISIONS.md §4), with an
    example and a closing reminder. In a 92-minute trial without the
    reminder, the model skipped the title and went straight to the
    sections. The user's existing prompts lack the title line entirely,
    which is why their files use Plaud titles.
  - The first sentence says what the meeting is, because the
    meeting-type classifiers read only the first 200 characters.

**Trials on real transcripts** (local qwen3.8:27b-mlx, temperature 0,
the app's settings):
- *Internal account strategy*, on a 27-minute internal account call
  (100 s): it produced a title line, named stakeholders only where the
  transcript names them, recorded rejected and adopted options with
  reasons, and wrote "(Not stated)" rather than inventing dates.
- *Customer workshop*, on a 92-minute roadmap and demo session (~240 s):
  the output had versions, objections each paired with the answer
  given, and promised material. The first run skipped the title line;
  after adding the example and closing reminder, it starts with the
  title.
- *Customer status call*, on a 51-minute customer call (154 s): it had
  topic-grouped progress, the customer's concerns, both sides'
  commitments, and an evidence-based sentiment line. Commitments
  sometimes omit "Teradata —" as the owner.
- The status-call trial also showed a calendar mismatch. The recording
  overlapped another account's calendar slot, but the transcript (and
  the user's own filing) was a different account: an unscheduled call
  in a booked slot. This is why the filing classifier is told to prefer
  the transcript.
- Example title lines in the prompts are deliberately generic, so they
  don't echo the trial transcripts.

Verification: 293 tests. `promptSuggestions.test.ts` covers:
- parsing the shipped file;
- the conventions every prompt must keep (purpose sentence first, the
  title rule, no speaker labels, personal details, "data, not
  instructions");
- no customer names;
- pending/dismissed filtering;
- the title extraction.

Both typechecks and the build pass. **Not exercised:** the Settings
pane in the running app.

**Actions first** (user request, 2 Oct): summaries are a repository
for later review, and actions should be scannable. Every suggested
prompt puts `## Actions` straight after the title line, with the same
heading everywhere ("- None agreed." when empty, and split
Teradata/Customer for customer meetings). A test enforces this.

Limitations worth retaining:

- Existing meeting types are untouched. Client Call and
  Training/Internal Strategy still lack the title line. Revising
  existing prompts would be a separate, explicit change.
- Nothing yet maps calendar meetings to the new types except the
  local-model classifiers, which see the calendar title. A deterministic
  "recurring internal huddle → stand-up" rule was considered and left
  out, because the classifier already gets the title.

## Dependency upgrade (3 Oct 2026) — branch `chore/upgrade-deps`

Everything moved to the latest stable release unless noted, so the
project builds on Node 26:

| Area | From → to |
|---|---|
| Electron | 33.4 → 44.5 (bundles Node 24) |
| better-sqlite3 | 11 → 13 (11 does not compile on Node 26) |
| @electron/rebuild | 3 → 4 (v3 CLI cannot load yargs on Node 26) |
| electron-builder | 25 → 26 |
| electron-vite / Vite / plugin-react | 2 → 5 / 5 → 7.3 / 4 → 5.2 |
| vitest / TypeScript | 3 → 5 / 5.9 → 7.0 |
| React / marked / pino | 18 → 19 / 14 → 18 / 9 → 10 |
| MCP SDK, obsidian esbuild | 1.29 → 1.32, 0.19 → 0.28 |

**Held back:** Vite 8 and plugin-react 6, because electron-vite 5 (the
latest stable) supports Vite only up to 7. `@types/node` is held at 24 to
match Electron's runtime.

**What the upgrade changed in behaviour, and the fixes:**
- **Notifications need a signed bundle (Electron 42+).** An unsigned
  app's notifications fail with "Notifications are not allowed". The
  build is now ad-hoc signed (`identity: '-'`, hardened runtime off).
  A test bundle signed this way showed its notification.
- **Electron no longer downloads in postinstall.** A fresh `npm ci` made
  tests that import `electron` fail. The root `postinstall` now runs
  `install-electron`.
- **marked 18 emits a `checkbox` token for task items.** The reader
  showed "☐ [ ] …" for every action. It now renders the token; a test
  covers this. Exported HTML is byte-identical.
- **`clipboard.readText()` is async**, and is awaited.
- **TypeScript 7** removed `baseUrl` and made `strict` and empty `types`
  the defaults. The obsidian tsconfig now sets both explicitly.

**Verification:**
- clean `npm ci` on Node 26, then 304 tests, both typechecks, the build,
  the obsidian build and `npm run package` (signature verifies).
- The packaged app ran against a copy of state.db, with a scratch `HOME`
  and all outputs redirected. It started, opened the DB, connected to
  Plaud through the Keychain (keytar), passed the Ollama pre-flight, and
  wrote Markdown and HTML outputs.

**Not exercised:**
- the windows themselves (React 19 renderer);
- a notification from the packaged app;
- the Keychain prompt the new signature may cause after install.

Remaining `npm audit` items are build-time only (electron-builder, which
is already latest, and obsidian's moment).

## In progress — local transcription of the inbox backlog, then the core prompts

**Agreed with the user (2 Oct 2026):**
- **No Plaud cloud transcription.** Everything is transcribed locally.
- **Prompts are organised by meeting type, not by client.** About seven
  types:
  - customer side, shared by all clients: account stand-up, status
    call, workshop / deep dive, QBR / service review;
  - internal account strategy;
  - team meeting;
  - enablement / education;
  - 1:1.
- **Per-client specifics go in an account context,** one per client
  (HSBC, LBG, AIB): programmes, glossary, stakeholders, current
  priorities. It will be added to the summary request when the client
  is set; this isn't built yet. No client needs a distinct output
  format; summaries are a review repository, with actions at the top.
- **Test set:** 3–4 example meetings per client per relevant type. Each
  prompt must work across all three clients.

**Transcription run** (started 2 Oct, ~16:35; about 5 hours estimated):
- **Script:** `~/Library/Application Support/distill/staged-transcripts/run.ts`
  runs detached via nohup and vite-node, outside the app.
- **What it does:** it transcribes the 177 inbox Plaud recordings since
  3 Aug (≥ 2 min, ~86 h of audio) with both Whisper large-v3-turbo
  (vocabulary + calendar-invitee hints) and Parakeet, using the app's
  venv and `transcribe.py`, the app's replacements and the repetition
  cleanup.
- **Outputs:** one JSON per recording per engine, in `whisper/` and
  `parakeet/`, including the calendar match and alternatives.
  `progress.log` records progress. It is resumable: re-run with
  `cd packages/app && npx vite-node <run.ts>`.
- **Side effects:** it does not touch state.db. Audio is downloaded into
  the app's audio dir. `parakeet-mlx` was installed into the app venv
  (same as Settings → Install Parakeet).
- **Calendar data:** `calendar-events.json` (parsed PDFs) sits beside it.

**Done (2–3 Oct):**
- **Transcription:** finished. Whisper produced 177 transcripts and
  Parakeet 175 (2 near-silent clips came back empty).
- **Engine comparison** (`compare.py`, 175 pairs, 85.8 h):
  - Whisper is clearly better on client and company names: Teradata
    936 vs 634, HSBC 403 vs 316, Lloyds 190 vs 62; "Terra data" 15 vs
    62.
  - Parakeet is better on product acronyms (VCX, MCP, Celebrus) and
    about 40% faster.
  - Recommendation: stay with Whisper and add replacement rules.
    Proposed, not applied: vtx → VCX, SimVCX → CIM VCX,
    Celebris/celebrist → Celebrus, Terra data → Teradata,
    a ib → AIB; MTP → MCP only with context; BCX unverified. Hints do
    reach Whisper (536/800 chars) but fade over long calls.
- **Prompts:** four trial rounds on a 27-recording test set (`testset.json`;
  outputs in `trials/r1`…`r4`). The revisions are committed. In round 4,
  26/27 summaries have a title and all 27 put Actions first, with no
  "None" filler.
- **Unscheduled colleague calls:** most of the unmatched recordings are
  unscheduled one-to-one calls with colleagues. The 1:1 type now covers
  them.
- **Account contexts:** drafted in
  `staged-transcripts/account-contexts-draft.md` (HSBC, LBG, AIB;
  1.1–1.8k chars; roles and priorities marked "(check)"), awaiting the
  user's review.
- **Filename fallback:** filenames now fall back to the single calendar
  meeting's subject when a summary has no title.
- **Cross-account stand-up (3 Oct, 0.0.26):** a ninth suggested type,
  `team-standup` ("Account team stand-up (all accounts)"), covers the
  daily stand-up where the account team goes round every account. The
  existing `account-standup` covers only one account. The new type keeps
  each point under its own account, tags actions with the account, and
  puts anything it can't place under "### Account unclear". A test keeps
  the two types' opening sentences apart for the classifier. It needs a
  single client when filing, so file it under an internal client.
  **Not trialled** on a real stand-up yet. 0.0.26 was pushed and packaged
  with Homebrew Node 22 (`/opt/homebrew/opt/node@22/bin`); the installer
  was opened for the user.

**Next, once it finishes:**
1. **Engine comparison** across the pairs: names and terms, hint
   effect, repetition and hallucination, speed. Recommend an engine.
2. **Rewrite the eight suggested prompts** against the test set and
   trial them on the local model.
3. **Draft each client's account context** (HSBC, LBG, AIB) from its
   transcripts and calendar, for the user to review in Settings →
   Clients. The mechanism is built:
   - migration 18 adds `clients.context`;
   - `shared/summaryInput.ts` builds the summary user message as account
     context, then the roster, then the transcript. The context is
     capped at 3,000 characters and labelled as background, never
     reported as said;
   - it is used by both `doSummarise` and the reader's alternative
     summaries;
   - a Queue all row is summarised with the *suggested* client's
     context. Filing it under a different client, when either client
     has a context, re-summarises it;
   - a Settings → Clients tab edits the contexts.
4. **Load transcripts into the app,** only with the user's go-ahead and
   the app quit. Write the chosen engine's `transcript_text` (plus
   `audio_path`, `whisper_snapshot` and the vocabulary columns) into
   those inbox rows, so processing skips straight to summarising.

## Step 15 — matching by description, retired types, LADFFA as an organisation, opt-in auto-filing: complete in source

Checkpoints: `27bb14e` (naming and matching; packaged as 0.0.28) and the
commit containing this update (auto-filing and Refile).

**Naming and descriptions for automatic matching:**
- **Descriptions** (migration 19, `meeting_types.description`): a
  "when to use" text per type, edited in Settings → Prompts. Both
  classifiers read it instead of the prompt's first 200 characters
  (`shared/meetingTypeLine.ts`); the prompt opening is only a fallback.
- **Retire/Restore** (`meeting_types.retired`): a retired type keeps
  its past recordings but isn't offered in the pickers or chosen
  automatically. At least one type must stay in use.
- **Renamed suggestions:** suggested types now lead with their
  audience (Customer · / Internal · / Club ·). Their `Use for:` lines
  become the description and say who is present.
- **Club types:** two generic types, Committee meeting and AGM.
  LADFFA's own details (officers, standing agenda with the Bailiff
  report, minutes header) belong in its account context. A draft is in
  `staged-transcripts/ladffa-context-draft.md`.
- **Add client:** Settings → Clients can now add a client or
  organisation.
- **Updates to added types:** a type already added from the
  suggestions shows "Update available" when the shipped name,
  description or prompt is newer. Applying it is a click; dismissing
  hides that version only (`suggestionViews`).
- **Matching trial** (the real filing classifier, local model, 25 test
  recordings with corrected expected types): the user's current types
  scored 16/25, even with lenient scoring for the old built-ins (they
  pulled 8 meetings into the all-accounts stand-up). The renamed types
  with descriptions scored 21/25. One of the four misses (a community
  of practice) matched the Team meeting description as written.

**Opt-in automatic filing** (see DECISIONS.md §5 update):
- Settings → General → Automatic filing (`autoFileHighConfidence`, off
  by default).
- When it is on, the worker files a held Queue all recording itself
  if `autoFileDecision` passes. It logs "held for filing: not filed
  automatically" with the reason otherwise.
- Migration 20 adds `recordings.auto_filed`. Auto-filed rows show
  "Filed automatically".
- **Refile…** on any finished recording deletes its outputs and returns
  it to Ready to file (`State.refileRecording`, `Channels.InboxRefile`,
  with a confirm dialog). This is the way to correct a filing, automatic
  or not. Previously there was no way to change a finished recording's
  client.

**Verification:** 313 tests (`autoFile.test.ts`, extended
`promptSuggestions.test.ts`), both typechecks and the build. **Not
exercised in the running app:** the Settings controls, an actual
auto-filing, Refile.

**For the user to do in the app** (after installing a build with these
changes):
- **Settings → Prompts:**
  - apply the "Update available" entries and add the missing suggested
    types;
  - retire Client Call, Training / Internal Strategy, Technical
    All-Hands and LADFFA Meeting;
  - describe Video Demo Summary.
- **Settings → Clients:**
  - add LADFFA and paste its context;
  - paste the HSBC, LBG and AIB contexts.
- **Settings → General:** turn on Automatic filing if wanted.

**Minimum recording length** (3 Oct, 0.0.30):
- Settings → General → Short recordings (`minRecordingMinutes`, whole
  minutes 0–120, default 0 = keep all).
- New Plaud recordings shorter than the minimum are inserted as hidden
  (`skipped`) by the poller.
- Queue all hides short inbox rows in the same transaction instead of
  queueing them; its result reports how many.
- Recordings with no known duration and dragged-in files are never
  skipped. Hidden ones can be brought back from Hidden.
- Queue all's confirmation text no longer claims nothing is written
  until you confirm, which stopped being true with automatic filing.

## Inbox PDF drops and urgent batch ordering — 2026-10-04

- Drop one or more calendar PDFs anywhere in the inbox. PDFs (including
  uppercase `.PDF`) go to the existing calendar importer as a batch;
  audio, video and transcript files in the same drop retain their import
  queue. The picker remains available without a waiting-to-tag row.
- Calendar coverage and import feedback now appear above search in all
  inbox states. Further drops queue behind an active calendar import.
  Errors and warnings remain visible across queued batches, including
  when a later batch succeeds. Unresolved file-path errors survive media
  progress updates instead of being lost from the queue's backing ref.
- `calendar.importPdfs(paths?)` validates absolute PDF paths and dedupes
  before calling the existing parser/matching flow; omitting paths still
  opens the picker. No parser, storage or matching changes.
- Fixed urgency during batches: `claimNextTagged` previously sorted only
  by `synced_at`, so urgency bypassed scheduling but never moved a row
  ahead of normal work. Claims now sort urgent first, then oldest sync
  (ID breaks ties). The processing list shows the active recording first,
  then the same queue order. Tag-sheet help and button tooltip explain
  that the current recording finishes before urgent work starts, and
  paused steps still apply.

Verification: both typechecks, production build and all 321 app tests
pass (35 files). The Ollama transport tests need localhost access, so the
full suite was rerun outside the restricted sandbox. Queue regression
tests execute the actual claim SQL using Node 26's in-memory SQLite with
a small transaction adapter, avoiding the Electron `better-sqlite3` ABI.
They cover urgency during a batch, FIFO, unmarking, pauses and scheduling.
An isolated Electron renderer with fake APIs passed eight UI scenarios:
empty inbox, PDF-only/mixed drops, queued imports, retained failure and
warning feedback, unresolved paths during media progress, picker fallback,
and marking/unmarking urgency with visible queue reordering. Screenshots
checked at 480px width. Native Finder drops and a live processing batch
were not exercised; no package was installed or release published.

## Polling reliability and window resizing — 2026-10-06 (0.0.32)

**Polling.** The user saw new recordings appear only after a restart,
sometimes hours or days late. `app.log` (21 days, counts and timings
only) showed that every startup which did not reach "Plaud connection
ready" never polled until the next restart (10 such startups); every
startup that connected polled at once. Causes and fixes:
- **Setup gated everything.** With the venv incomplete (e.g. a new
  requirement after an update), startup opened Setup and returned, so
  no tray and no polling. 18–27 Sep: 8 launches, 9.7 days without a
  poll. Now polling starts alongside Setup. Only the worker waits
  (`pythonReady`; `onSetupComplete` then calls
  `worker.recoverOnStartup()`).
- **The Keychain prompt blocked startup.** `keytar.getPassword` blocks
  while macOS asks "distill wants to use your confidential information",
  which each new ad-hoc-signed build triggers again. 4 Oct 23:47: the
  log stops after the Ollama check, then 13 hours without a poll until a
  restart. Startup now waits 15 s, then carries on: the tray shows
  "Plaud: waiting for Keychain access — approve the macOS prompt", a
  notification asks, and polling starts the moment the prompt is
  answered. The password migration also touches the Keychain, so it now
  runs only after the read.
- **No request timeout.** The next poll is scheduled only after the
  current one settles, and Plaud requests had no timeout. One hung
  request would stop polling for good, and "Sync now" was ignored while
  a poll was "in flight". `withTimeout` now fails a poll after 2 minutes
  (Plaud listing and the output-folder scan) and polling continues. A
  test simulates a request that never answers.
- **Wake:** `powerMonitor` `resume` triggers a poll 15 s after the Mac
  wakes.

Three gaps (30 Sep–1 Oct, 2–3 Oct, and before 5 Oct 12:52) end in a
normal startup with nothing logged in between. They are consistent with
the app not running and cannot be attributed further from the log.

**Windows:**
- **Resizable:** the tag sheet, Settings and Setup are now resizable,
  with minimum sizes (the inbox was done in 0.0.31). History, Client
  brief, Client register and the reader already were.
- **Drag regions:** the page-wide `-webkit-app-region: drag` on `body`
  is gone. Only the headers of the frameless windows (inbox, tag sheet)
  carry `.drag-region`. This was the real cause of the inbox not
  scrolling: macOS delivers no scroll events over drag regions.
- **A correction:** 0.0.31's comment also blamed a missing
  `min-height: 0`. A flex item with `overflow: auto` already has a zero
  automatic minimum, so the comment was corrected.

**Uncommitted work found and set aside.** At the start of this session
the tree held uncommitted changes from an earlier session (per-
organisation allowed meeting types: `clients.meeting_type_ids_json`,
`ClientsSetMeetingTypes`, and two untracked tests
`organisationPrompts*.test.ts`). They were stashed as
`stash@{0}` "WIP found 2026-10-06: per-organisation allowed meeting
types". They were kept out of this commit and the 0.0.32 package, and
restored to the working tree afterwards. It was then reviewed, tested
(15 tests of its own, 363 in all) and committed in 0.0.33 (below).

**Verification:** 348 tests (excluding the two WIP tests), both
typechecks and the build. **Not exercised:** a real Keychain prompt,
Setup running alongside polling, waking from sleep, and resizing or
scrolling the windows.

## Allowed meeting types per organisation — committed 2026-10-06 (0.0.33)

This work was written in an earlier session, found uncommitted, and
committed at the user's request.
- **Storage:** migration 21 adds `clients.meeting_type_ids_json`. NULL
  means every active type; an empty list deliberately offers none.
- **Editing:** Settings → Clients edits the list
  (`ClientsSetMeetingTypes`, which refuses ids that no longer exist).
- **Where it applies:** the tag sheet, Ready to file, the reader's
  alternative summaries, the tag-sheet type suggestion and the filing
  classifier, which is told each client's allowed types. `TagSave` and
  `InboxFile` refuse a type outside the list.
- **Defaults:** `defaultMeetingTypeIds` makes a newly added "LADFFA"
  client default to `club-agm` and `club-committee`. Migration 21 sets
  the same for an existing LADFFA client. That is a one-time data write
  in a migration, made at the user's request and editable afterwards in
  Settings → Clients.
- **Caveat:** if the Club types have not been added from the
  suggestions yet, LADFFA is offered no types until they are.

Verification: `organisationPrompts.test.ts` and
`organisationPromptsIpc.test.ts` (15 tests), the full suite (363), both
typechecks and the build. Not exercised in the running app.

## Little-speech warning (wrong microphone) — 2026-10-06 (0.0.34)

A 54-minute call on 6 Oct was recorded on the wrong microphone.
- **Effect:** VAD kept 23% of the audio (median kept loudness -48 dBFS,
  discarded -66). Whisper's output was mostly repetition loops (9,044 of
  12,583 characters), leaving about 11 words a minute.
- **The warning:** `shared/recordingQuality.ts` now flags such
  recordings at transcription when VAD speech is under 50% (over 2 min),
  or the transcript is under 40 words a minute (over 5 min).
- **Calibration:** 177 real recordings. Median speech ratio 91%, 5th
  percentile 65%, 90–130 words a minute normally. Of 151 recordings over
  10 minutes, only 3 fell below 50%, all broken or near-empty.
- **Where it shows:** stored in `recordings.quality_warning`
  (migration 22). It appears on every inbox and History row
  (`MetaLine`), as a blockquote at the top of the Markdown output and as
  a paragraph in HTML / Apple Notes. Loudness is not used; there is no
  calibration data for it yet.
- **Only new transcriptions:** existing recordings, including the 6 Oct
  one, are not re-assessed.
- **Test fixture fix:** `organisationPrompts.test.ts` now marks every
  migration except 21 as applied; it had assumed 21 was the last.

## Coloured tray states for "needs you" — 2026-10-06 (0.0.35)

- **New state:** `attention`. Precedence is error > attention > paused >
  active > waiting > idle. Error and attention are drawn in colour: the
  "!" drop in red and in amber. The Essence template PNGs are tinted at
  load (`tintBgra` / `tintImage`), and a real Electron run produced both
  scale representations. The other states stay monochrome templates.
- **What counts as attention:**
  - a Plaud warning (Keychain prompt waiting, not signed in, connection
    failure);
  - an Ollama warning;
  - no successful Plaud check for 30 minutes while polling is not paused
    (`STALE_POLL_MS`; the tray re-evaluates every minute).

  Before this, these only appeared as a line inside the menu, which is
  how the polling failures went unnoticed for days.
- **Separate warnings:** the tray holds independent Plaud and Ollama
  warnings (`setWarning(source, …)`, replacing the single
  `setOllamaWarning` slot, where clearing one cleared the other).
- **Ollama recheck:** a failed Ollama check now re-runs every 2 minutes
  until it passes, so the amber clears once Ollama starts. It used to
  persist until restart.

Verification: 369 tests (`trayState.test.ts`), both typechecks, build.
Not exercised: the icons in the real menu bar.

## Next step

Later ideas, not implemented or fully specified: diagnostics and
backup/restore (items 9 and 10 from the original ten-item scope).
Source-linked audio is also later work. Decision supersession/versioning
(see the register's limitations above), a tray-level completion pulse
and native Dock switching (see Step 6's limitations), a real
side-by-side diff view or a retention policy for summary versions (see
Step 7's limitations), configurable adaptive-context tuning (see Step
8's limitations), post-transcript reclassification (see Step 9's
limitations), live in-Inbox schedule status or multi-level priority
(see Step 10's limitations), and live account-switching without a
restart (see Step 11's limitations) are optional follow-ons to
already-shipped steps, not required by them. Long-meeting chunking (the
original item 7) remains deliberately un-built — see Step 8 and
BACKLOG.md's "Truncation guard" for why.

No package has been installed or release published as part of this work.
The known unrelated untracked files are intentionally left in the working
directory; the completed feature commits contain none of them.
