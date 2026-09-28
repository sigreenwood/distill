# Session 2026-04-26 — Truncation guard, BACKLOG cleanup, parked features

Durable record of what was decided and what shipped in the 26 Apr 2026
session. Format: each session log captures (1) what shipped with commit
hashes, (2) what was decided about the BACKLOG including drops and
parks with reasoning, and (3) honest disclosures about what hasn't
been verified.

## Shipped

### feat(transcribe): collapse Whisper repetition artefacts (`3254e0b`)

New module `packages/app/src/main/transcriptCleanup.ts` collapses
hallucinated repetition runs that Whisper produces during silences,
background music, mumbling, and eating sounds. Real distill outputs
contained patterns like "Repeat Repeat Repeat..." 50+ times, "Yeah.
Yeah. Yeah..." 40+ times, "I've been so sad. I've been so sad..."
6+ times.

Two-pass regex strategy: single-word repeats (8+ identical occurrences
in a row) collapse first to prevent the multi-word pass from
matching pairs and stranding lone words. Then 2-6-word phrase
repeats (5+ identical occurrences with optional trailing
punctuation) collapse. Both replace runs with one occurrence
followed by a `[…]` marker so the reader knows something was
collapsed.

Conservative thresholds: 5+ identical multi-word phrases or 8+
identical single words. "Yeah, yeah, yeah, exactly" is normal
conversation and stays untouched. Runs of 5+ are essentially
always Whisper artefacts in practice.

Wired into `pipeline/steps.ts::doTranscribe` between the vocabulary
replacements pass and the row write so summariser, stored
transcript, and any downstream consumer see clean text. 14 unit
tests covering the canonical patterns plus edge cases (empty
input, paragraph preservation, real chunk from a sample
transcript).

### feat(summarise): bump default num_ctx to 64k + truncation warnings (`a014986`)

Two-part fix for Ollama's silent input truncation when prompts +
transcripts exceed `num_ctx`:

Part 1, context window bump. `normaliseConfig` migrates
on-disk `contextWindow` from exactly 32768 (the old default) to
65536. Manually-set values (16k, 131k, anything bespoke) are
preserved untouched. Fresh installs with no `ollama` block at all
also get 65536. Idempotent — running normaliseConfig twice
produces the same result. Costs ~4-6GB more unified memory while
qwen2.5:32b is resident; on a 48GB M4 still comfortable but
exacerbates the existing laggy-laptop-during-processing problem.
example.config.json bumped to 65536 to match.

Part 2, post-summarise truncation flag and UI badges. New module
`pipeline/tokenBudget.ts` estimates input tokens via chars/4
with a 3000-token output reserve. Returns
`{ estimatedInputTokens, budget, exceedsBudget, contextWindow }`.
`doSummarise` runs the check before submitting, logs a warning
when over budget, and persists the flag plus the actual numbers
on the row.

New columns on `recordings` (migration 9):
- `truncation_warning INTEGER NOT NULL DEFAULT 0`
- `estimated_input_tokens INTEGER` (null until summarise runs)
- `context_window_at_submit INTEGER` (null until summarise runs)

DTO additions: `truncationWarning`, `estimatedInputTokens`,
`contextWindowAtSubmit`. `toInboxDTO` maps them.

Inbox UI: pre-tag duration hint on `WaitingRow` (1h30m yellow
"summary quality may suffer", 3h red "summary likely to lose
detail"). Post-summarise badge on `CompleteRow` when
`truncationWarning` is set, with tooltip carrying the actual
overshoot numbers. New `--warning` CSS variable distinct from
`--danger`.

Caller updates: `poller.ts` and `localImport.ts` both pass the
three new fields as 0/null on insert. `setStatus` patch type
extended in `state.ts`.

23 new unit tests (16 token budget, 7 config bump). 173/173 tests
pass overall (was 150 before this commit, plus the 14 from the
Whisper cleanup commit earlier in the session).

Why this and not split-and-remerge: The contributor considered both paths.
Split-and-remerge (chunk transcript, summarise each part, LLM-merge
the partial summaries into one coherent final) was properly
designed but rejected as 2 days of careful work for a problem
that's simpler to solve by giving the model a bigger window. The
bump alone removes truncation risk for any meeting up to ~6 hours
of conversational speech; the warning catches anything that still
slips through.

## BACKLOG decisions

The session applied a consistent skeptical lens to every live
BACKLOG entry: "what concrete pain does this solve?" Entries that
couldn't pass the test were dropped or parked, freeing the live
list to contain only items with real signal.

### Dropped entirely

`c5f03a6` **Search section** dropped. The contributor's pushback: markdown / HTML
outputs are already searchable through better external tools
(Spotlight, HoudahSpot, EagleFiler, ripgrep, Apple Notes' own
search). The app's job is to produce durable artefacts; reinventing
search in-app duplicates work for marginal gain. The genuinely
unique value (cross-meeting RAG with citations, structured
aggregations like sentiment trends) would be a different product
framing — "corpus assistant", not "search" — and shouldn't be
roadmapped as a search-tower until there's real demand for it.
Note: an earlier `110cbff` commit had rewritten the section as a
three-tier plan, which `c5f03a6` then deleted. Two consecutive
commits adding then removing reads incoherently in git log but
honestly reflects the conversation.

`d80a8d1` **Live re-connect on Plaud credential change** dropped.
The entry's own text conceded user-facing impact was "one extra
Cmd-Q + relaunch after a sign-in event that happens once per
account." Maybe a handful of events over the lifetime of the app
against an estimated focused-day of work touching the worker
lifecycle (`Worker.recoverOnStartup` assumes app launch, not
mid-flight rebuild). Justification was "worth doing before any
other user installs", but Shape B is parked and any other Plaud
user would also sign in once and forget about it. Weak ROI.

`c3c8424` **Prompt management remaining items** dropped. Reviewed
each sub-item with explicit signal questions:
- Token count hint under prompt editor: never hit Ollama's context
  window in practice. Speculative defence.
- Paste-as-new button: 5-second convenience over a working flow.
- Pre-seed new prompts with template: solves a problem only
  hypothetical users have. Shape B parked.
- Duplicate prompt for per-client variants: had real signal —
  the contributor has wanted variants by client. But the better answer is
  Shape C: write the prompt itself to branch on client name
  ("if client is X, emphasise A; if Y, emphasise B"). The
  model handles that. Zero code, zero schema. If Shape C turns
  out not to work (model ignores branching, prompt becomes
  unwieldy at three or four clients) the per-client variant
  feature can be re-added with concrete pain. Per-client prompt
  overrides via a clients-to-meeting-types junction table is the
  right architectural shape if that day comes.

### Parked (gated on a real trigger)

`e383847` introduced a new "Parked" section above "Later milestones"
in the BACKLOG. Different from "live" (re-litigated every review)
and "deleted" (design rationale lost). Each parked entry must have
an explicit gating condition.

**Edit-before-save** moved to Parked. Today summaries land in
Markdown / HTML / Apple Notes — all of which the contributor can
edit in place. No external egress. Speed-of-correction wins are
modest.
Trust-calibration argument cuts both ways (most users would
habitually click "Save as-is"). Gating condition: outbound
integration ships (Salesforce, email draft, push-to-Confluence)
**OR** real usage produces summaries needing edits often enough
to save meaningful work. Full design preserved in the parked
entry: new `reviewing` status, `review_before_save` column on
`meeting_types`, Reviewing section in inbox, plain textarea
editor, edge cases for editor-closed-without-saving and
relaunch-with-reviewing-row.

### Live BACKLOG end-of-session

Down from 11 sections at session start to 7:
1. Real usage shakedown — DO THIS FIRST
2. Multi-user onboarding — Shape B (gated on product decision)
3. Performance under load (5 numbered options, #1 shipped)
4. Dual-machine coordination (when M5 enters)
5. Regenerate outputs (UI over existing schema)
6. Settings editor in packaged builds (at .pkg time)
7. Commit reminder on repo state drift (tiny)

Plus Parked (Edit-before-save), Later milestones, Known issues,
Backfill (resolved, kept for design context), Shipped appendix.

## Decisions captured

### Tier 3 search: rejected as a roadmap entry

The session briefly explored a three-tier search plan (FTS5 keyword,
embeddings, RAG with the local model) but the contributor pushed back that
external Mac search tools handle tiers 1-2 better. Tier 3 (RAG over
the corpus with citation-backed answers like *"What did the speaker say
about MCP security last month?"*) is the genuinely unique value.
But it's a different product framing — corpus assistant, not search
— and shouldn't be roadmapped until there's real demand. Dropping
the entry today doesn't preclude building it later; the design
sketch is preserved in commit `110cbff`'s message and in this
session log.

Sentiment trend (parsing `📊 Sentiment Score: N` out of summaries
into a column, charting over time per client) was identified as a
separately-shippable structured-data feature — not search at all.
Not pursued this session because dropping the search entry made it
homeless. If revisited, it's still a half-day of work and ships
standalone value.

### Token budget thresholds

Computed from chars/4 over prompt + transcript with 3000-token
output reserve:
- 32k context, ~1200-token prompt, 3000-token reserve → ~28k
  budget for transcript ≈ ~21,000 words ≈ ~2h15m of speech at
  150 wpm. A real ~2h call sat right at this limit during testing.
- 64k context bumps the budget to ~60k transcript tokens ≈
  ~45,000 words ≈ ~5 hours.
- 131k context (qwen2.5:32b max) handles essentially anything.

Pre-tag duration hints (renderer-side, computed off
`duration_seconds`):
- 1h30m yellow ("summary quality may suffer" — model attention
  thinning even before truncation)
- 3h red ("summary likely to lose detail")

The 3h red is conservative against the new 64k window — meetings
around 3-5h actually fit. Wording is honest (quality drift before
truncation) but worth knowing if revisiting. Truncation at 64k
starts around 6-7h.

## Honest disclosures

What I haven't verified:

- The migration on the contributor's live database. Code path is the same as
  migrations 1-8 which all worked, but I haven't actually run
  it against the contributor's data. Migration 9 adds three columns with safe
  defaults (`NOT NULL DEFAULT 0` for the boolean flag, nullable
  INTEGER for the two value columns). Should be safe.
- The contextWindow bump on the contributor's live config. Will run on next
  app launch — code path is in `normaliseConfig` and tested for
  idempotency, but the actual on-disk file at
  `~/Library/Application Support/Plaud Local/config.json`
  hasn't been touched.
- The duration thresholds against real meetings. The 3h/red
  threshold says "likely to lose detail" but a 5h meeting at 64k
  probably still fits — the contributor will calibrate from real use.
- The `--warning` colour `#d6a900` in dark mode against the
  contributor's actual setup. If hard to read, easy adjust.
- The Whisper cleanup against a full live transcript. Tested
  against synthetic and real chunks but not yet exercised on a
  full meeting end-to-end. When the contributor next processes a recording with
  the kind of dead-air repetition that triggered "Repeat Repeat
  Repeat" in the original test transcript, the line `cleaned whisper
  repetitions` with `runsCollapsed` and `charsRemoved` should
  appear in logs.

## Repo state at session end

- Branch `main`, **57 commits ahead of origin** (origin is a
  fork; the contributor backs up via a separate path)
- Working tree clean
- 173/173 tests pass, typecheck clean for both `tsconfig.node.json`
  and `tsconfig.web.json`, production build clean
- Last 10 commits:
  - `5cbcf33` docs(app): log truncation guard ship in BACKLOG appendix
  - `a014986` feat(summarise): bump default num_ctx to 64k + truncation warnings
  - `c3c8424` docs(app): drop "Prompt management — remaining items" entry
  - `e383847` docs(app): introduce Parked section; move Edit-before-save into it
  - `d80a8d1` docs(app): drop "live re-connect on Plaud credential change" entry
  - `c5f03a6` docs(app): drop search section from BACKLOG entirely
  - `110cbff` docs(app): rewrite Search section as tier 3 plan; log import + cleanup ships
  - `3254e0b` feat(transcribe): collapse Whisper repetition artefacts
  - `1dbf5e4` feat(import): multi-file queue with per-file progress and proper picker timing
  - `ac94fe0` fix(inbox): correct header count and Recent expand toggle

## What to do first next session

1. Quit and relaunch distill so the contextWindow bump migration
   fires and migration 9 runs against the live database.
2. Open the inbox, confirm long-meeting rows show the duration
   hint and (if you happen to have one) any completed row that
   exceeded budget shows the post-summary badge.
3. Process a recording with known dead-air or music that triggers
   Whisper repetition. Confirm the cleanup pass fires (look for
   `cleaned whisper repetitions` in logs).
4. If anything's off, the three calibration knobs are: the duration
   thresholds in `Inbox.tsx::describeDurationRisk`, the
   `OUTPUT_TOKEN_RESERVE` constant in `pipeline/tokenBudget.ts`, and
   the cleanup thresholds in `transcriptCleanup.ts`.
