# Roadmap — staged delivery

The full spec in `01-overview.md`..`08-errors-testing.md` + `06-self-maintaining.md` describes the target end state. It is deliberately too much for a first build. Ship in layers.

## v1 — minimal, local, Markdown-only

**Goal**: prove the whole pipeline end-to-end in real use before investing in polish.

See `SPEC-v1.md` for the authoritative v1 build spec.

**In scope**:
- Poll Plaud cloud, inbox, manual tag (client + meeting type, addable inline)
- Local Whisper transcription (no diarisation)
- Summarise via **local Ollama** using meeting-type prompts (per-Mac model: `qwen2.5:32b` on 48GB, `qwen3:14b` on 24GB)
- Write Markdown file to `~/Documents/distill/{client}/`
- Minimal tray: icon, inbox count, "Sync now", "Quit"
- Runs in dev mode (`pnpm dev`) or as an unsigned `.app` double-clicked manually
- `config.json` at `~/Library/Application Support/distill/` (no secrets — Ollama is local)
- Uses existing Plaud recordings as test data; assume fresh start when going live

**Explicitly deferred**:
- Apple Notes integration → v1.1
- `.pkg` installer + `launchd` autostart → v1.1
- First-run wizard → v1.1
- Keychain for secrets → v1.1
- Diarisation → v1.2
- Per-meeting-type diarisation toggle → v1.2 (committee meetings only)
- Rich Settings UI → v1.2
- Note rating (👍 / 👎) → v1.2
- Model update checks → v2
- Prompt improvement suggestions → v2
- Pre-tag queue → open question, see below

**Estimated effort**: 1–2 weeks of Claude Code time, if the Plaud-sub-without-Pro sync works as hoped.

## v1.1 — Apple Notes + distributable

**Goal**: the contributor can install on all their Macs via double-click and notes land in Apple Notes alongside the Markdown backup.

**In scope**:
- Apple Notes output via `osascript` (or Shortcuts — to be evaluated)
- AppleScript concurrency mutex (two recordings finishing simultaneously)
- Markdown stays as durable backup
- `.pkg` installer with ad-hoc signing (per `07-install.md`)
- `postinstall` script writes LaunchAgent, loads via `launchctl bootstrap`
- First-run wizard (checks Ollama is installed, offers to pull the right model for this Mac, writes config.json)
- Pre-tag menu item (open question, answer required before starting v1.1)

**Prerequisites**:
- v1 has been used for at least a few weeks on real recordings
- Plaud-sub-without-Pro question has been confirmed working

## v1.2 — diarisation + richer UI + rating

**Goal**: speaker attribution where it matters (committee meetings), full Settings UI, note rating.

**In scope**:
- Per-meeting-type diarisation flag (default off; on only for committee meetings)
- pyannote bootstrap (HF token, licence acceptance flow)
- React-based Settings window (clients, meeting types, prompts with history, transcription settings)
- 👍 / 👎 rating on completed notes + optional free-text comment
- Rating storage feeds into v2 reflection

**Prerequisites**:
- v1.1 shipped and running on all the contributor's Macs
- HF licences accepted manually on pyannote's two model pages

## v2 — self-maintaining

**Goal**: app notices drift and suggests changes — always with user approval.

**In scope**:
- Weekly model-update checks:
  - Ollama registry (`https://ollama.com/library`) for newer Qwen / Llama releases
  - HuggingFace for newer MLX Whisper variants
  - HuggingFace for newer pyannote releases (once v1.2 adds diarisation)
- Model compare-on-one-note flow before switching (re-summarise the same transcript with old and new model side-by-side)
- Prompt improvement from thumbs-down aggregation (the redesigned approach — not full-transcript reflection)
- Manual "deep reflection" as opt-in feature that sends batches of transcripts + summaries to the local model for review (free since inference is local — the cost concern that would have shaped this feature with a cloud API no longer applies)
- Rollback UI for both model and prompt changes

**Prerequisites**:
- v1.2 has accumulated rating data on real recordings
- Open question: shape of reflection (thumbs-down aggregation vs full-transcript) resolved with the contributor

## Open questions parked for later phases

These were raised during spec design and deferred along with their phases. Re-surface before starting the relevant phase.

| Question | Phase that needs it | Default if unanswered |
|---|---|---|
| Minimum pre-tag menu option ("next recording gets X") | v1.1 | Include it — 20 lines of code, matches the contributor's original instinct |
| Reflection shape: thumbs-down aggregation vs full-transcript analysis | v2 | Thumbs-down aggregation as primary, full-transcript as manual opt-in |
| Shortcuts app vs osascript for Apple Notes writes | v1.1 | Evaluate during v1.1 build; pick the more reliable |
| Standalone Python (`python-build-standalone`) vs `uv` bootstrap | v1.1 installer | `uv` first; switch to bundled if first-run failure rate is noticeable |

## Non-goals across all phases

**Sep 2026 update:** local natural-language meeting search is now in scope:
summaries by default, with explicit optional transcript search. See
[`HANDOFF.md`](./HANDOFF.md) for current development status.

State these up front so they don't creep in:

- No Windows or Linux builds
- No recording from the Mac microphone
- No sharing / collaboration / multi-user
- No USB-direct fallback unless the Plaud-Pro-sync risk materialises
- No voice identification (named speakers) without a proper voiceprint registration flow — anonymous diarisation only, if any
