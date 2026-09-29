# distill — menu bar app

A Mac-only menu bar app that replaces the Plaud Pro subscription workflow: poll Plaud cloud, transcribe recordings locally on Apple Silicon, summarise via a **local LLM running in Ollama**, and write the result to disk (Markdown in v1, Apple Notes from v1.1).

Everything runs on the Mac. No cloud APIs, no API keys, no data leaves the machine except (a) Plaud metadata + MP3 downloads and (b) one-time Ollama model pulls.

## Start here

For the current development state and next task, read [`HANDOFF.md`](./HANDOFF.md)
first. The phase documents below are historical specifications.

**If you are Claude Code** (or building manually), read files in this order.

1. [`ROADMAP.md`](./ROADMAP.md) — what to build in what order, and what's deferred
2. [`SPEC-v1.md`](./SPEC-v1.md) — the authoritative build spec for v1 **(build this first)**
3. [`PROMPTS.md`](./PROMPTS.md) — verbatim seed prompts for the four meeting types

Everything below is reference material for later phases. Do not implement from it directly — use `SPEC-v1.md` as the build target.

## Reference material (v1.1 and beyond)

These documents describe the target end state across all phases. They were written before `SPEC-v1.md` and contain more scope than v1 covers. Several sections reference the Anthropic API for summarisation; **that is now superseded** — the app uses local Ollama at runtime instead. Use the reference material for architecture, data model, UI, and installer ideas, but substitute Ollama for Anthropic in any pipeline step.

| File | Phase that needs it | Scope |
|---|---|---|
| `01-overview.md` | v1.1+ planning | Full architecture and in/out of scope for the eventual end state. Note: Anthropic API references should be read as Ollama. |
| `02-structure.md` | v1.1+ | Final repo layout (more files than v1 needs) |
| `03-data-model.md` | v1.2+ | Full SQLite schema including `prompt_history`, `prompt_suggestions`, `model_suggestions` |
| `04-pipeline.md` | v1.2+ | Full pipeline. The summarise step described there uses Anthropic; swap for Ollama. The Apple Notes + HTML conversion sections are still valid for v1.1. |
| `05-ui.md` | v1.2+ | Full UI including Settings window, rating, suggestion windows |
| `06-self-maintaining.md` | v2 | Model update checks + prompt improvement. Updaters now check Ollama registry, not Anthropic + HF. Cheaper reflection since local inference is free. |
| `PROMPT_GENERATION_PROMPT.md` | any | Meta-prompt for generating meeting-type prompts via an external LLM. Encodes the filename-title contract and the temperature-0 findings. |
| `07-install.md` | v1.1 | `.pkg` installer, LaunchAgent, first-run wizard — all still relevant |
| `08-errors-testing.md` | v1.1+ | Error taxonomy, logging, full test strategy |

## Conventions

- **Verify** means Claude Code must check current docs / package registry at build time rather than trusting a version string in the spec.
- **v1**, **v1.1**, **v1.2**, **v2** — phases defined in `ROADMAP.md`.

## Key decisions already made (don't revisit)

Negotiated with the contributor before specs were written:

- **Source**: Plaud device → Plaud cloud, using the existing JWT in `@plaud/core`. (Critical: depends on Plaud cloud sync working without a Pro subscription — verify before building.)
- **Transcription**: local, MLX Whisper on Apple Silicon.
- **Diarisation**: deferred to v1.2, then on only for the committee meeting type.
- **Summarisation**: **local LLM via Ollama**. No cloud LLM dependency. Per-Mac model choice:
  - 48GB M4 → `qwen2.5:32b`
  - 24GB M5 → `qwen3:14b`
- **Output**: Markdown files on disk in v1; Apple Notes added in v1.1 alongside Markdown.
- **Workflow**: inbox-first. Nothing processes until the user manually tags it.
- **Known clients**: none seeded by default. Users add their own from the tag sheet's "+ Add new client…" affordance.
- **Meeting types**: none seeded by default. Users add their own from Settings -> Prompts. Earlier shapes seeded a small set (`client-call`, `training`, `all-hands`, `ladffa`) that were tuned for one contributor's preferred output and didn't generalise.
- **Distribution**: `.pkg` installer with ad-hoc signing from v1.1. v1 runs in dev mode.
- **Self-maintaining**: v2 feature. When it lands, updates are suggestions only — never auto-applied.

## No compliance concern in v1

Earlier spec drafts flagged a compliance question about routing client transcripts through Anthropic's API. Moving to local Ollama removes that concern entirely — no client content leaves the Mac at any point in the pipeline.

## Local meeting search

The inbox includes a **Search your meetings** box. Ask a question such as “A call with HSBC that talked about DR”, then choose **Search summaries**. After results arrive, **Search available transcripts** runs the same question against transcript text only. There is no automatic transcript fallback, download, or transcription.

Search includes hidden recordings with locally stored text or a known Markdown export. Results show the source, date, exact excerpts, and a button to reveal saved notes. Missing source text is counted; the newest 30 matches are displayed. Standalone files that Distill does not know about are not scanned.

The configured local Ollama model converts the question into required concepts and alternative phrases (for example, DR / disaster recovery). All concepts must match the selected text or recording name/client. The interpreted terms are displayed so you can refine an overly broad or narrow interpretation. This is language-assisted phrase retrieval, not an exhaustive semantic index or a conversational answer generator. If interpretation fails, search explicitly falls back to keywords. Search requires a loopback Ollama host and a local model; it does not send recording contents to the model.

Summary and transcript results are retained for the current question so you can switch back without repeating the request. Editing or clearing the question resets them; submitting **Search summaries** runs a fresh search.
