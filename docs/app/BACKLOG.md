# distill — backlog

Running list of known gaps, polish items, and ideas logged during the build.
Captured here rather than in chat so they survive across sessions.

Sorted roughly by impact × ease. Cross off as they land.

> **See also:** [`DECISIONS.md`](./DECISIONS.md) — design decisions for the
> Prompts and Vocabulary editor work (Apr 2026). Some items below cross-ref
> specific sections.
>
> **Looking for what already shipped?** Jump to the
> [Shipped — appendix](#shipped--appendix) section at the bottom. Anything in
> the live sections above is genuinely still to-build (or to-decide).
>
> **Considered and consciously deferred?** See the
> [Parked](#parked--not-building-yet-but-logged-so-the-design-isnt-lost)
> section above the appendix. Parked entries have an explicit
> gating condition for when they should be revisited.

---

## Real usage shakedown — DO THIS FIRST

Don't build more polish until a few real meetings have run through. The
useful list will be the things that annoy you in real use, which may not
match anything below.

Suggestions for what to watch for:

- **Summary quality per meeting type.** Do client-call summaries read like
  what you'd actually send? Does the training prompt produce something
  worth keeping? Does the committee meeting type need diarisation enough to promote it from
  v1.2 to v1.1?
- **Model choice.** *(Updated Jul 2026 — the app now picks a default
  sized to the Mac's RAM and checks weekly for newer generations; see
  appendix.)* Current tiers: `qwen3.6:35b` on the 48GB M4, `qwen3.6:27b`
  on the 24GB M5. Watch whether the 27b is slow enough on the M5 to be
  annoying for back-to-back meetings, and whether `qwen3.5:9b` is close
  enough that the speed wins for routine types.
- **Reconstruction parity.** *(Jul 2026)* The entire `packages/app`
  source was rebuilt from the compiled v0.0.1 bundle after the iCloud
  incident. It typechecks, builds to near-identical bundle sizes, and
  boots against the real state.db — but the first few real meetings
  through the rebuilt pipeline double as a parity check. Watch for any
  behaviour that differs from what v0.0.1 did.
- **Notifications.** Are the "Summary ready" toasts useful or noise?
  Consider batching (one toast per hour) if they pile up.
- **First-poll catch-up.** *(Partly answered Jul 2026.)* Hit for real on
  the M5: a 1000-recording Plaud library going back to Apr 2025 meant
  "skip all existing" left the inbox stubbornly empty after sign-in.
  Recent-N now ships as `initialPollInboxCount` (provisional default
  **10**). **Still to decide before a wider release:** is 10 the right
  number, and should it be surfaced in Settings rather than
  config-file-only?
- **Name / term accuracy.** How often does Whisper mangle
  participant names or industry-specific product names? If it's more
  than once per meeting, the vocabulary work needs another pass (see
  "Per-meeting-type vocabulary contribution" under [DECISIONS.md §2](./DECISIONS.md)).

---

## Natural-language meeting search — summaries first

*Added Sep 2026 to the personal-use improvement list.* Use local Ollama
to interpret questions such as "a call with HSBC that talked about DR".

- **Default: search summaries.** Submitting a new question searches
  available summaries, including hidden recordings.
- **Optional: search transcripts.** After the summary search, offer
  **Search available transcripts** for the same question. Search
  transcripts only when explicitly selected, including when the summary
  search finds no matches.
- Show the recording title, date, client, matching excerpts and whether
  each result comes from a summary or transcript, with access to the
  saved notes.
- Report unavailable content clearly. Transcript search uses existing
  transcripts; it does not trigger transcription of recordings.
- Keep inference local. If Ollama interpretation is unavailable, label
  the fallback as exact keyword matching.

Implemented as the first Sep 2026 development checkpoint in
`MeetingSearch.tsx` and `meetingSearch.ts`. Automated checks, a browser
fixture, and a synthetic query against the configured local Ollama model
have been exercised. Packaging and installation are separate from this
source checkpoint; see [HANDOFF.md](./HANDOFF.md).

---

## Silent degradation — the theme of the Jul 2026 shakedown

*Logged Jul 2026 after a day of real use.* Almost every bug found that
day had the same shape: **the app kept working and quietly did the
wrong thing**. None threw an error the user could act on.

- VAD was shipped but never enabled on an upgraded venv — transcription
  still worked, so nothing looked wrong.
- `temperature: 0.3` made four runs of one transcript agree on 18% of
  named entities. Every individual summary looked fine.
- A 27B model on 24GB ran at 0.57 tok/s (35x slow) with 9.4GB of swap.
  No error, just 33-minute summaries.
- A 64k context killed Ollama mid-request; the row said `fetch failed`.
- Whisper produced lowercase, unpunctuated transcripts for a meeting's
  opening because no `initial_prompt` was passed.
- The Markdown output folder didn't exist, and there was no way to tell
  whether that was normal or broken.

Each is fixed, but the class isn't. **Proposal: a Health / Diagnostics
pane in Settings** — one screen answering "what is actually happening?"

- Ollama: reachable, model, resident size vs machine RAM, measured
  tok/s from the last run, context window, temperature
- Whisper: model, VAD enabled or not (and why not), last run's speech
  ratio
- Python venv: path, packages present or missing
- Outputs: each destination's resolved path, exists/writable, iCloud or
  not, count written
- Plaud: signed in, token expiry, last poll result
- A "copy diagnostics" button for pasting into a bug report

Most of the underlying checks already exist (`inspectOutputDir`,
`preflight`, `detectVenv`, `getPlaudAccountStatus`, the `vad` stats in
the transcript JSON) — this is mostly a surface, not new logic. It
would have caught five of the six bugs above in seconds.

---

## Live re-connect after a Plaud sign-in

*Hit for real Jul 2026.* Signing in from Settings → Sources stores the
credentials, then does nothing until the app is restarted: at startup
`connect()` threw `PlaudNotAuthenticatedError`, so neither the poller
nor the worker were ever constructed, and signing in later doesn't
retroactively create them. The app shows a "restart to apply" toast,
which works but is a poor first-run experience — the most likely moment
for a new user to conclude the app is broken.

Fix shape: after a successful sign-in, if `poller` is null, run the
same bootstrap block that `continueBootstrap()` runs — build the Plaud
client, worker and poller, then kick a poll. Needs care so a second
sign-in doesn't create a duplicate poller.

---

## Config defaults never reach existing installs

*Noticed Jul 2026 while planning the second-Mac install.* Every config
value is `cfg.x ?? default`, so improving a default only helps fresh
installs. A machine that has run distill before keeps `temperature:
0.3` and `keepAlive: 5m` indefinitely, including the temperature value
now known to cause 18% run-to-run agreement.

Deliberately NOT auto-migrated: silently rewriting a value the user may
have chosen is the same trap as the old 32768 -> 65536 context bump,
which made the setting unfixable by hand.

Options worth weighing:
1. A `configVersion` field, plus migrations that run once and are
   recorded, so a given migration can never re-apply.
2. Surface it instead of changing it: Settings shows "this differs from
   the recommended value (why)" with a one-click apply.

Option 2 is more in keeping with the suggestion-only rule the project
already follows for models and prompts.

---

## Multi-user onboarding — Shape B (non-Plaud user)

Shape A (another Plaud user) is shipped; see appendix.

**Shape B** is a non-Plaud user — someone who wants the
transcribe → vocabulary-correct → summarise → write-to-Markdown
pipeline for local audio files only, with no Plaud account.

What blocks them today:

- The startup sequence runs Plaud preflight, points the welcome
  notification at Settings → Sources, and shows "Plaud: not signed in"
  in the tray if no JWT exists.
- The poller is unconditionally on; it errors quietly forever
  without a JWT.
- No "I'm not using Plaud" mode — no way to skip the Plaud-related
  paths and use the app purely for local imports.

What would unblock them: a config flag, e.g.

```jsonc
"plaud": {
  "enabled": true   // back-compat default
}
```

When `false`: skip preflight, skip poller construction, skip JWT
load, hide "Sync now" in the tray, and rewrite the welcome flow to
say "drag audio in to get started." Settings → Sources gains a
disabled-state for the Plaud card; flipping the toggle re-enables
the Plaud path.

Focused half-day technically. The harder part is the product
decision below.

### Product decision needed before building

This is the bit that should sit until there's a clearer answer.
Two framings:

**Option A — keep the Plaud framing.** The app stays "distill."
Non-Plaud mode is a documented secondary use case ("works without
Plaud too — just drag files in"). Smaller code change. Single
audience.

**Option B — rename and reframe.** App becomes something like
"Meeting Notes Local" (or another name); Plaud becomes one of N
source connectors. The pipeline is the product, sources are
plugins. Bigger change — naming, marketing, welcome flow, tray
text, docs, repo layout — but matches reality if the contributor would actually
use the app for non-Plaud sources at all.

The right answer depends on whether the contributor ever wants to feed Otter /
Fathom / generic audio files into this pipeline as a regular
source, or whether that's an edge case for the rare
meeting-without-the-Plaud-device. Real usage will tell.

### Why this isn't urgent

Nobody other than the contributor is using the app today. The friction for
another user is real but theoretical. The non-Plaud case is
completely speculative. Logged so it isn't lost; not worth
building until either someone wants to use the app, or the contributor has a
clear answer to Option A vs B.

---

## Performance under load — laggy laptop during processing

*Logged Apr 2026 from real use.* On a 48GB M4, the laptop becomes
noticeably laggy during pipeline processing (especially on Teams calls
or while doing other heavy work). Root cause: when all three workloads
overlap — Whisper transcription on the Neural Engine + Ollama with
`qwen2.5:32b` resident (~20GB) + Electron + macOS overhead — unified
memory hits 35-40GB resident and the system starts swapping.

Pause is one lever (shipped); reducing the Ollama keepAlive default
from `24h` to `5m` shipped too. Other levers worth considering as
separate follow-up work, ranked by lowest cost first:

**1. Smaller Ollama model option.** ~~`qwen2.5:14b` uses ~9GB instead of
~20GB.~~ *Shipped Jul 2026 as hardware-aware recommendations:* fresh
installs default to a model sized to the Mac's unified memory
(`modelAdvisor.ts` tiers: 48GB→35b, 24GB→27b, 16GB→9b), and
Settings → About documents the tier table for manual switching. What
remains of this lever is surfacing a one-click "low-RAM mode" preset
for existing installs; low priority now the guidance is in-app.

**2. Per-meeting-type model override.** New optional column on
`meeting_types` (`ollama_model_override` or similar). Falls back to
global default. Lets the user use 32b for high-stakes client-call
summaries and 14b for routine training/all-hands. Modest schema +
pipeline change.

**3. Per-meeting-type Whisper model.** Same shape as (2) but for
Whisper. `whisper-base` is several times faster and uses far less RAM
than `large-v3`. Quality drop is real, especially on names and
technical terms — but the vocabulary system compensates. Most
useful for routine recordings where speed matters more than perfect
transcription.

**4. Defer summarise step until idle / scheduled time.** Most powerful
lever; biggest design lift. New pipeline state
(`tagged-summarise-deferred` or similar). User configures: "summarise
between 22:00 and 06:00" or "summarise when laptop has been idle for
10 minutes". Transcribe runs immediately so the transcript is
available; summarise waits for the configured window. Keeps daytime
snappy at the cost of summaries arriving overnight rather than
mid-meeting.

**5. Auto-detect system pressure.** Read `vm_stat` / IOReport / similar
to detect whether the laptop is currently under high CPU or memory
pressure, throttle accordingly. "It works until it doesn't" risk;
lower priority than 1-4 above.

No immediate plan to build any of these; logged so they're not lost.
Real usage will tell which levers are worth pulling.

---

## Transcription quality — staged plan (Jul 2026)

Agreed after reviewing a proposed
`DeepFilterNet → Silero VAD → whisper → pyannote → …` pipeline.

**Stage 1 — shipped Jul 2026.** Silero VAD speech gating in
`transcribe.py` (bundled `silero_vad.onnx` via onnxruntime — torch-free
on purpose). Non-speech is dropped before Whisper sees it, which
attacks hallucinations at the cause (the TS-side repetition cleaner
stays as second line of defence) and cuts transcription time roughly
in proportion to silence removed. Conservative tuning: 0.35 threshold
with hysteresis, 200ms padding, 500ms merge gap; join silence capped
at 2s so paragraph-break logic still works. Falls back to no-VAD with
a stderr warning if onnxruntime is missing, so old venvs keep working.
`vad` stats (speech ratio, segments, removed seconds) flow to the app
log. Also added the `whisper-large-v3-turbo` preset (~5-6× faster,
small accuracy cost mostly on rare names — the vocabulary system's
job anyway). VAD + turbo together is the biggest available cut to the
laggy-laptop problem.

**Eval harness.** `python/ab_compare.py` runs transcribe.py with and
without VAD over real recordings and reports timing, speech stats,
and word-level similarity — run it on a few real meetings before
trusting any transcription change (shakedown-first, as ever).

**Stage 2 — DeepFilterNet, parked until pyannote (v1.2).** Denoising
before Whisper is *not* a free win: large-v3 is trained on noisy
audio, and denoiser artifacts can make already-clean (Teams/Zoom)
recordings transcribe worse. Design when built: `denoise: "auto" |
"on" | "off"` with a cheap SNR probe deciding "auto"; denoise to a
temp file (never touch `audio_path`); DFN runs at 48kHz *before* the
16kHz downsample. Bundle with pyannote because (a) diarisation
embeddings degrade in noise much faster than Whisper does — DFN's
real beneficiary — and (b) they share the torch dependency, keeping
today's venv light.

**Rejected: faster-whisper backend.** CTranslate2 is CPU-only on
Apple Silicon; MLX keeps the Metal GPU path. Revisit only if MLX
Whisper stalls as a project.

---

## Regenerate outputs for a completed recording

*Priority dropped Jul 2026:* transcript re-import now covers the common
case — dragging a summary's `.md` back onto the inbox re-summarises the
same transcript without re-transcribing, which is what "regenerate"
was mostly wanted for. What re-import does NOT do is re-run outputs on
the *same* row (e.g. after changing the output folder, or to re-write
only Apple Notes after a failure), so this is still worth building —
just no longer urgent.

Follow-on to the fan-out idempotency work (see [`DECISIONS.md` §1](./DECISIONS.md)).
Per-destination write timestamps already exist; a "Regenerate outputs"
action becomes cheap UI work:

- Inbox context menu on a `complete` row → **Regenerate outputs**.
- Optional chooser: all destinations, or a specific one (Markdown only /
  HTML only / Apple Notes only).
- Action clears the chosen `*_written_at` timestamps and transitions the
  row to `tagged`. Worker picks it up; only cleared destinations run.
- Useful after prompt edits (now with fresh summary) or after changing
  output destination folder (regenerate to the new location).

**Not new code** — just a UI surface + IPC over existing schema.

---

## ~~Settings editor writes in packaged builds~~ — resolved

*Flagged Apr 2026; confirmed resolved Jul 2026 during the source
reconstruction.* Option 1 (copy-on-first-run) is what actually shipped
in v0.0.1: `migrateVocabularyToUserDir` copies bundled
`resources/vocabulary/` into `Application Support/distill/vocabulary/`
on launch (never overwriting), and both the loader and the Vocabulary
pane read/write the user-local path via `userVocabularyDir()`. Packaged
builds are safe. The "edits show up as git diffs" dev property was
traded away, as the option 1 write-up predicted.

---

## Commit reminder on repo state drift

A small one: on dev startup, if `git status` in the app package is
dirty AND the last commit is > 2 days old, log a gentle reminder. Not
critical — just a nudge to commit working state before iterating.

---

## Parked — not building yet, but logged so the design isn't lost

Features that have been considered and consciously deferred. Each
entry has an explicit gating condition — build when that condition
fires, not before. Parking is different from "shipped" (already
done), "live" (genuinely pending decisions), and "dropped from
BACKLOG entirely" (not worth keeping the design around). These
are designs worth preserving but not worth building today.

### Edit-before-save (gated on a real review trigger)

*Logged Apr 2026, parked Apr 2026.* The idea: some meetings are
important enough that LLM-generated summaries should be reviewed
before they hit the final destination; others are routine and the
LLM is trusted. Make this a per-meeting-type opt-in so the decision
is made once, at the meeting-type level, not per recording.

**Why parked.** Today, summaries land in Markdown / HTML / Apple
Notes — all of which the contributor can edit in place after the
fact. There's
no egress to anywhere external (no CRM push, no email draft, no
shared OneNote), so a bad summary doesn't escape the laptop. The
workflow "produce summary → read later → edit if wrong" already
works. Edit-before-save buys speed-of-correction (modest) and
trust-calibration (modest, and would mostly result in a habitual
"Save as-is" click).

Gating condition for un-parking: **either** distill grows an
outbound integration (Salesforce, email draft, push-to-Confluence,
anything where the summary leaves the local machine and becomes
harder to edit), **or** real usage produces summaries that need
editing often enough that catching them at production time would
save meaningful work. Today neither is true.

**Flow when built:**

- New column on `meeting_types`: `review_before_save` (boolean,
  default false).
- After the summarise step, if the meeting type requires review,
  the pipeline enters a new `reviewing` status instead of going
  straight to `writing`.
- Inbox shows a `Reviewing` section with two actions per row:
  **Edit & save** (opens the summary in a small editor window,
  user edits, click save → pipeline resumes at write) or
  **Save as-is** (pipeline resumes immediately).
- The editor is a plain `<textarea>` with the summary pre-filled.
  No rich text editing in v1.

**Default per built-in meeting type:** all four (`client-call`,
`training`, `all-hands`, `ladffa`) default to false so current
behaviour is unchanged. User enables on important types via the
Prompts pane.

**Why opt-in per type rather than global:** the trust call is
driven by meeting type, not ad-hoc. Client-call on a contentious
topic is high-stakes; a weekly internal stand-up is not.

**Alternative considered — global dialog per recording:** rejected.
Interrupts every pipeline with a decision, adds UI friction,
defeats the "tag and forget" flow.

**Edge cases to design when un-parked:** what happens when the
editor is closed without saving (treat as "save as-is" or treat
as "cancelled"?), what happens to a `reviewing` row on app
relaunch (must show in inbox so user can find it), what happens
if the user retries a `reviewing` row (return to `summarising`
or stay where it is?).

---

## Later milestones (from ROADMAP.md)

Already planned, kept here as a pointer:

- **v1.1**: ~~`.pkg` installer~~ (shipped Jul 2026, v0.0.2 onward);
  ~~Launch on Login~~ (shipped Aug 2026, v0.0.18) — Settings → General →
  Startup. macOS owns the setting, so it is read from the OS on every
  settings load rather than mirrored into config.json; turning it off in
  System Settings → Login Items turns it off in the app. The save reads
  the value back and reports an error if macOS declined the registration,
  which it can do for an unsigned app.
- **v1.2**: Diarisation; thumbs-up/down rating
- **v2**: Self-updating models/prompts; Plaud device USB pulldown fallback.
  *Partially landed early (Jul 2026):* the model half shipped — weekly
  registry check for newer generations of the configured family, with
  notification + Settings → Performance banner and user-approved
  download. Prompt reflection and the USB fallback remain v2.

---

## Known issues / gotchas

Worth documenting so we don't rediscover them:

- `better-sqlite3` ABI mismatch between Electron and system Node means
  vitest can't use the real DB. Pipeline tests use an in-memory fake via
  the `InboxStore` interface. Don't try to use real SQLite in tests
  without a pre-test rebuild dance.
- `@plaud/core` ships raw `.ts` (no build step). `electron-vite.config.ts`
  must include it in `externalizeDepsPlugin({ exclude: [...] })` or
  Electron's CJS loader crashes on `export` at runtime.
- Plaud's `start_time` is epoch **milliseconds**, not seconds. Don't
  multiply by 1000. (Burned by this once — filenames dated year 57,000.)
- Electron main-process code changes need a full dev restart. Only
  renderer code hot-reloads.
- `keytar` (the Keychain library used by `KeychainCredentialStore`) is
  in maintenance mode since 2022. Works fine on macOS today but worth
  knowing if Electron drops it. Replacement candidates:
  `@napi-rs/keyring` (maintained), or a small `osascript` wrapper around
  `security add-generic-password`.
- After a Sources sign-out, `~/.plaud/config.json` keeps `password: ""`.
  The CLI (`@plaud/core` with `FileCredentialStore`) reads the empty
  string directly without consulting Keychain — so the CLI thinks
  you're signed-out-with-empty-password, not signed-in-via-Keychain.
  By design: the CLI is a separate tool that hasn't been updated to
  read from Keychain. If you need the CLI working alongside the app,
  re-run `plaud login` from a terminal.
- Plaud's API uses HTTP 200 with `status: -302` to signal region
  mismatches, not a real HTTP redirect. `PlaudClient.request` handles
  the redirect (bounded to one retry since the Jul 2026 review);
  `PlaudClient.getMp3Url` previously swallowed every non-2xx into
  `null` (the recording-deleted path), which masked auth failures and
  other real errors. Now distinguishes 404 (returns null) from
  everything else (re-throws). Originally commit `c11d418` (lost in
  the iCloud incident); behaviour recovered into `@plaud/core` during
  the salvage.
- **Never keep this repo in iCloud Drive.** The original working copy
  lived in `~/Library/Mobile Documents/...`; iCloud destroyed
  `.git/objects` and deleted most tracked files (Jul 2026). The app's
  TypeScript source only survived because the installed v0.0.1 bundle
  was unminified. Work from `~/dev/distill`, push early and often to
  `github.com/sigreenwood/distill`.

---

## Backfill `original_prompt_hash` — context for future you

*Status: resolved by `State.revertMeetingTypeToBuiltin`.* Documented
here in case the same shape recurs with a future migration.

Migration 7 added `original_prompt_hash` on `meeting_types`. New
installs seed it from PROMPTS.md; pre-migration-7 installs got NULL
on existing rows, so the "modified from default" badge silently never
worked for those rows.

The fix that landed: revert-to-default rewrites `original_prompt_hash`
as well as the prompt text, so revert acts as "reset everything to
factory including the reference hash". Safe because revert is an
explicit user action.

Alternative considered but rejected: one-off migration that
backfilled `hashPrompt(current_prompt)` for every NULL row. Would
have permanently mismarked already-edited prompts as "the default".
The user-action approach is safer.

If a future column has the same NULL-on-existing-rows problem,
prefer the user-action fix over the auto-backfill.

---

## Shipped — appendix

Compact log of completed work, kept so future-me can see what
landed without scrolling through obsolete designs. Items are roughly
chronological within each grouping. Commit hashes where I have them;
git log fills in the rest.

> **Note on pre-Jul-2026 hashes:** the original repo's history was
> destroyed in the iCloud incident, so hashes older than the salvage
> (e.g. `c11d418`, `8b80e9a`) no longer resolve. They're kept as
> historical markers; the behaviour they describe was recovered into
> the reconstructed source.

### Salvage + rebuild session (Jul 2026)

- **Repo salvage after iCloud destroyed the working copy.** `.git`
  objects and most tracked files lost; toolkit packages restored from
  the public GitHub remote, `python/` + `resources/` recovered from
  the installed v0.0.1 bundle, docs survived locally. New private
  home: `github.com/sigreenwood/distill`, working copy `~/dev/distill`.
  (`e46043f`)
- **Toolkit review hardening.** Bounded the `-302` region-redirect
  retry, `res.ok` check + fallback on temp-URL downloads, YAML title
  escaping in `sync`, masked password input at `plaud login`. Tests
  added. (`08b1e3f`)
- **Full `packages/app` source reconstruction** from the unminified
  compiled bundle: main process, preload, and all four renderer
  windows as typed TS/TSX. Typechecks clean; build output matches
  v0.0.1 bundle sizes; dev run boots against the production state.db
  with zero migration drift. `@plaud/core` gained the CredentialStore
  abstraction back (it had only existed in the lost repo).
  (`5b43b9d`..`f6bda98`)
- **Hardware-aware model defaults + weekly upgrade suggestions.**
  `modelAdvisor.ts` RAM tiers drive fresh-install defaults and a
  "Choosing a local model" section in About; weekly registry probe
  suggests newer model generations (qwen3.7, qwen4, …) via
  notification + Performance-pane banner with user-approved streaming
  download. Suggestion-only throughout. 14 unit tests. (`481e2ec`)

### Sources / Plaud sign-in (this session, Apr 2026)

- **Sources pane with in-app Plaud sign-in.** New first tab in
  Settings. Email + password + region form. `@plaud/core` refactored
  with a `CredentialStore` interface; CLI uses the file-backed
  default, app uses Keychain (`distill.plaud` service). One-time
  migration removes password from `~/.plaud/config.json` after
  Keychain has a verified copy. (`8b80e9a`)
- **Re-auth button on auth errors + auto-bootstrap first run.**
  `is_auth_error` column (migration 8); `prettifyError` returns
  `{ message, isAuthError }`; new `app.openSettings({ tab })` IPC
  channel; "Sign in again" button on auth-error inbox rows opens
  Settings on Sources. `loadConfig` auto-copies `example.config.json`
  on first launch — no more "copy this file and restart" dialog.
  (`1bb403f`)
- **getMp3Url no longer swallows auth errors.** Bug surfaced by the contributor:
  signing out then clicking Tag & Process on a cached row produced
  "Plaud did not return a download URL" instead of "Sign in again".
  Root cause was a `try { ... } catch { return null }` that routed
  every error type into the same path. Now distinguishes HTTP 404
  (recording gone, returns null) from all other errors (rethrows).
  (`c11d418`)

Outstanding within Sources: live re-connect on credential change
(see top of file).

### Settings panes

- **Outputs / Markdown / HTML / Apple Notes.** Three destinations,
  each with `enabled` flag, directory or parent-folder, and
  `includeTranscript` toggle. Apple Notes via `osascript`.
- **Prompts pane.** Built-in + user meeting types, modified-from-default
  badge, revert-to-default, edit prompt body. Per-prompt save.
  See [`DECISIONS.md` §3](./DECISIONS.md).
- **Vocabulary pane.** Per-scope editor (global, organisation, industry,
  plus
  one per client). whisperHints + replacements + free-text notes.
  Reads/writes `resources/vocabulary/<scope>.json` directly.
  See [`DECISIONS.md` §2](./DECISIONS.md).
- **General pane.** Audio-retention checkbox + days input mapping
  to the tri-state `audioRetentionDays` field (null / 0 / N).
- **Performance pane.** Ollama model dropdown (live from `/api/tags`),
  keepAlive dropdown (5 presets), curated MLX Whisper dropdown.
  (`9b8b128`)

### Pipeline / inbox

- **Whisper accuracy tuning: disable per-segment conditioning + reorder
  prompt + tighten prompt cap.** Three small, independent changes
  addressing failure modes seen on a long real-world meeting and
  tightening the prompt-bias side. (1) `transcribe.py` now passes
  `condition_on_previous_text=False` to `mlx_whisper.transcribe`. The
  default (True) feeds each segment's output back as context for the
  next; in practice this is the single biggest source of the "Repeat
  Repeat Repeat..." / "Yeah. Yeah. Yeah..." hallucination loops the
  cleanup module had to mop up afterwards (once a hallucinated phrase
  enters the conditioning context, the model loops on it for hundreds
  of tokens). Trade-off is minor coherence loss across segment cuts;
  for business meetings that fall at sentence boundaries this is the
  right call. The cleanup module stays as belt-and-braces. (2)
  `vocabulary.ts::buildWhisperPrompt` now puts hints BEFORE the
  preamble, not after. Whisper's prompt window is ~224 tokens and an
  overlong prompt is silently truncated at the END by the tokeniser.
  Old ordering ("This is a business meeting. Terms that may appear:
  ...") meant truncation dropped the actual domain terms while keeping
  boilerplate. New ordering ("<term1>, <term2>, ... This is a business
  meeting.") inverts that: hints survive, framing is what gets dropped
  if anything must. (3) `WHISPER_PROMPT_CHAR_LIMIT` lowered from 1000
  to 800 chars to stay comfortably under the ~224-token window (the
  old limit was already over). 2 new vocabulary tests pin the
  ordering and cap behaviour; 195/195 tests pass overall (was 193).
  Verified against MLX-Whisper's source that the kwarg name and
  default match (line 71 = `True`, line 532 forwards to decode loop).
  Not yet verified end-to-end against a re-run of the original audio;
  expectation is the cleanup module's `runsCollapsed` count drops to
  near-zero on meetings that previously triggered it. (`3b0905e`)
- **Cross-machine completion via Markdown frontmatter scan.** Solves
  the dual-machine problem (the contributor runs an M4 and an M5; both sync iCloud
  Drive Documents to the same Markdown output folder) by adopting any
  recording the other machine has already processed rather than
  re-running the pipeline. New module `processedElsewhere.ts` scans
  the configured Markdown output dir at every poll, parses YAML
  frontmatter from each `.md` file, and returns a Map of `recording_id`
  to ProcessedRecord (markdown path, mtime, model, whisper model).
  Poller consults the Map before deciding row status: matches go in
  as `complete` with `processed_externally = 1`, `markdown_path` and
  `markdown_written_at` populated from disk, `model_snapshot` and
  `whisper_snapshot` populated from frontmatter; no transcript /
  summary text in the DB (the markdown file is the source of truth).
  Inbox UI surfaces a small folder-icon hint on these rows showing
  the model name ("Processed on another machine (summary by
  qwen2.5:14b)") so the user knows which machine produced the summary
  and with what model — important because the M5 has 24GB unified
  memory and runs `qwen2.5:14b` while the M4 runs `qwen2.5:32b`.
  Initial-poll catch-up still skips everything (cross-machine signal
  doesn't override the explicit "don't notify me about old stuff"
  intent). Migration 10 adds `processed_externally INTEGER NOT NULL
  DEFAULT 0`. Markdown disabled → lookup returns empty Map, no
  cross-machine detection, single-machine semantics restored.
  Replaces the old leader/follower / iCloud-claim-file design ideas
  in BACKLOG: those traded user friction (config gymnastics) or
  correctness risk (iCloud sync latency) for the same outcome this
  achieves with neither. 16 new processedElsewhere tests + 4 new
  poller tests = 193/193 pass overall (was 173).
- **Truncation guard: 64k context default + post-summarise warnings.**
  Ollama silently truncates inputs that exceed `num_ctx`, producing
  summaries missing the start of the meeting. Two-part fix: (1) bump
  default `contextWindow` from 32768 to 65536 in `normaliseConfig`,
  applied to existing configs at exactly the old default and to fresh
  installs; manually-set values preserved untouched. (2) Pre-flight
  token-budget check in `doSummarise` (chars/4 estimator with a 3000-
  token output reserve). When over budget, log a warning and persist
  `truncation_warning=1`, `estimated_input_tokens`, and
  `context_window_at_submit` on the row (migration 9). Inbox UI shows
  a yellow badge on completed rows where the flag is set, plus a
  pre-tag duration hint on `WaitingRow` (1h30m yellow, 3h red) so
  the user knows before processing that a long meeting may produce
  a degraded summary. New `--warning` CSS variable for non-blocking
  warnings, distinct from `--danger`. 23 new unit tests (16 token
  budget + 7 config bump). 173/173 tests pass. Split-and-remerge
  was considered as an alternative and rejected as 2 days of work
  for a problem the bump-and-warn fix solves cheaply. (`a014986`)
- **Whisper repetition cleanup.** Real distill outputs (an early
  long meeting) contained long runs of hallucinated repeats
  produced by Whisper during silences, background music, mumbling,
  or eating sounds ("Repeat Repeat Repeat..." 50+ times; "Yeah.
  Yeah. Yeah..." 40+ times; "Thank you. Thank you..." 10+ times).
  These polluted summariser input and the transcript embedded in
  HTML/Markdown outputs. New module `transcriptCleanup.ts` collapses
  runs at the earliest point in the pipeline (right after
  vocabulary replacements, before the row write). Two-pass regex:
  8+ identical word occurrences and 5+ identical 2-6-word phrases
  collapse to one occurrence + `[…]` marker. Conservative thresholds
  preserve natural conversational repetition ("yeah, yeah, yeah"
  left alone). 14 new unit tests against real-world chunks.
  (`3254e0b`)
- **Multi-file import queue with per-file progress.** The single
  `importing` flag was replaced with a queue of `ImportEntry`
  rows in renderer state. The `+` button stays enabled during
  imports so files can keep being queued. Native picker uses
  `multiSelections`, returning N paths in one shot. Drag-and-drop
  accepts N files. Each entry shows phase (queued / probing /
  copying / extracting / finalising) and percent (0-100 or
  indeterminate). Sequential queue loop — one ffmpeg at a time,
  since they're CPU-heavy. Bug fix as a side-effect: "Importing…"
  no longer appears before a file has been picked, because the
  queue is empty until enqueue. Main-side already had the
  byte-level streaming copy and ffmpeg `time=`-line parsing.
  (`1dbf5e4`)
- **Tray live status.** Status line shows current step. Four-state
  tray icon (idle / processing / paused / error) generated by
  `scripts/generate-tray-icons.py`.
- **Auto-dismiss completed rows.** `autoDismissCompleteMinutes` in
  config; sweeps opportunistically on every `inbox.list`.
- **Pause controls.** Master toggle plus per-step (polling, download,
  transcribe, summarise) via tray submenu. Mid-pipeline pause reverts
  to `tagged` so the row re-claims cleanly.
- **Audio retention sweep.** Locally-imported audio gets pruned N days
  after most-recent successful output write. Plaud-sourced audio never
  swept. Tri-state: null = never, 0 = on completion, N = days. Sweeps
  at startup and every 24h.
- **Recent section collapsed by default.** Inbox is quiet by default;
  the Recent section toggles open via a chevron.
- **Filename format.** `{YYYY-MM-DD HH-MM} - {Client} - {Title}` where
  the title is the first line of the summary. Built-in prompts updated
  to seed the title line.
- **Error message quality.** `errorMessages.ts` maps common failures
  (Ollama not running, missing model, Plaud auth, transcription crash,
  disk full, DNS, etc.) to actionable text.

### Vocabulary

- **Whisper `initial_prompt` bias** + **post-transcription
  find-and-replace.** Reads from `<userVocabularyDir>/*.json` (global,
  organisation, industry, plus per-client). Per-meeting-type vocabulary
  contribution explicitly **not** building — meeting types are about
  tone/structure, not terminology. See [`DECISIONS.md` §2](./DECISIONS.md).

### Other

- **Backfill `original_prompt_hash`.** Resolved via
  `State.revertMeetingTypeToBuiltin` rewriting the hash. Notes kept
  in main body above for migration-design reference.
- **Typecheck and test debt cleared.** Seven latent issues fixed in
  `6b2cb09`, `e2a1dcc`, `8ea109a`. Typecheck and test pass on both
  `tsconfig.node.json` and `tsconfig.web.json`.
