# distill

A Mac menu-bar app that turns meeting recordings into summaries, entirely
on-device: poll Plaud cloud (or drag a file in) → transcribe with MLX
Whisper → summarise with a local model via Ollama → write Markdown, HTML
and Apple Notes.

macOS on Apple Silicon only. No cloud LLM, no API keys. The only network
calls are Plaud (your own recordings), the Ollama registry (model
existence checks), and Hugging Face (one-time Whisper weights).

## Do not review `salvage/`

`salvage/compiled-app/` is **compiled JavaScript**, not source. It is the
extracted bundle of the last release built before iCloud Drive destroyed
this repo's git history in July 2026, and it is the only surviving record
of the original `packages/app` source. It is committed deliberately, as a
reference for reconstructing intent, and is never built or imported.

Reviewing it produces nothing useful. See `salvage/README.md`.

## Layout

```
packages/core      Plaud API client (auth, listing, download). Ships raw
                   TypeScript; bundled into the app by electron-vite.
packages/cli       `plaud` command — login, list, sync, download.
packages/mcp       MCP server exposing recordings to an MCP client.
packages/app       The Electron app. main / preload / renderer.
packages/app/python  transcribe.py + bundled Silero VAD weights.
docs/app           Specs, decisions, backlog. BACKLOG.md is the live list.
```

## Commands

```bash
npm test                                    # vitest, from the repo root
cd packages/app && npm run typecheck        # both tsconfigs
cd packages/app && npm run dev              # electron-vite dev
cd packages/app && npm run package          # unsigned .pkg into dist/
```

Main-process changes need a full dev restart; only the renderer hot-reloads.

## Constraints that are settled

Do not reopen these in review; they are decisions, not oversights.

- **Local-only inference.** Ollama for summaries, MLX Whisper for
  transcription. No cloud LLM, ever — the point is that client meeting
  content never leaves the machine.
- **Inbox-first.** Nothing processes until the user explicitly asks.
- **Suggestion-only.** Model updates, prompt changes and config
  recommendations are surfaced for approval and never auto-applied. A
  past migration that silently rewrote a config value made that setting
  unfixable by hand; see `resolveContextWindow` in `config.ts`.
- **Per-destination idempotency.** `*_written_at` columns mean a retry
  re-runs only the destinations that failed. Apple Notes has no upsert,
  so re-running it duplicates notes. See `DECISIONS.md` §1.
- **`temperature: 0`.** Summarising is extraction, not writing. At 0.3,
  four runs of one transcript agreed on 18% of named entities.

## Known traps

- **Comments asserting untested behaviour.** Three bugs in one day came
  from confident comments that were wrong: "streaming keeps the socket
  alive so the timeout never fires" (it does not, during prefill),
  "Notes has no per-note URL scheme" (it does — `show note id`), and a
  claim that vocabulary hints were needed to fix mangled names (the
  style anchor did it). Treat explanatory comments in this codebase as
  claims to verify, not as documentation.
- **Model size is not the constraint; headroom is.** A 27B model fits in
  24GB and runs at 0.57 tok/s while swapping. See `modelAdvisor.ts`.
- **`better-sqlite3` ABI.** Rebuilt against Electron, so vitest cannot
  open a real database. Tests use pure functions or in-memory fakes.
- **`@plaud/core` ships raw `.ts`** and must stay in
  `externalizeDepsPlugin({ exclude })` or Electron's loader crashes.
- **Plaud `start_time` is epoch milliseconds**, not seconds.

## Where the risk is

`ipc.ts` (~1300 loc) has no direct tests. Neither do `outputs.ts`
(generates filenames — a collision overwrites a summary),
`audioRetention.ts` (deletes files) or `paths.ts` (renames the user's
data directory). Their core logic is pure and testable; the tests simply
have not been written yet.
