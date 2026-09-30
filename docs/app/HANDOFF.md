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

## Next step

Suggested: a confirmed action/decision register — the persistent
"status" the brief deliberately does not claim. Let the user confirm
items from a brief (or a meeting) into a per-client register with
open/done state they set, each linked to its source meeting. Keep it
user-confirmed: no automatic status inference. Same rules as before —
one bounded slice, tests, build, UI check, handoff in the same commit.

Later ideas, not implemented or fully specified: confirmed action/decision
register; correction-to-vocabulary suggestions; versioned re-summarisation;
long-meeting chunking/coverage; idle/overnight processing; diagnostics and
backup/restore. Source-linked audio is also later work.

No package has been installed or release published as part of this work.
The known unrelated untracked files are intentionally left in the working
directory; the completed feature commits contain none of them.
