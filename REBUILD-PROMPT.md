# distill v2 rebuild — prompt for Claude (Fable 5)

You are starting a new version of **distill**, a Mac-only menu-bar app that replaces the
Plaud Pro subscription: poll Plaud cloud for new recordings, transcribe locally (MLX
Whisper on Apple Silicon), summarise with a local LLM via Ollama, and write Markdown
(and later Apple Notes). Everything runs on the Mac; no cloud LLM, no API keys.

This repo is a **salvage** of the previous version. Read this file fully before touching
anything — the history matters.

## State of this repo

The original repo lived in iCloud Drive, which destroyed its `.git` objects and deleted
most source files (2026-07-27). What you have now:

| Path | Provenance | Status |
|---|---|---|
| `docs/app/` | Survived locally | **Complete and authoritative** — full spec suite |
| `packages/core`, `packages/cli`, `packages/mcp`, `packages/obsidian`, `scripts/` | Restored from GitHub `sergivalverde/plaud-toolkit` @ 810c7ce | Real TypeScript source, reviewable |
| `packages/app/` (configs, `python/`, `resources/`) | Configs survived; `python/` + `resources/` restored from the installed app bundle | Real files |
| `packages/app/src/` | **LOST** — original TypeScript gone | Must be rebuilt |
| `salvage/compiled-app/` | Extracted from installed distill v0.0.1 | Unminified compiled JS — read-only behavioural reference for the lost source (see `salvage/README.md`) |
| `private/MY-VOCAB.md` | Survived locally | User's transcription vocabulary |

## Read order

1. `docs/app/README.md` — orientation + key decisions already made (do not revisit them)
2. `docs/app/ROADMAP.md` — phasing (v1 → v1.1 → v1.2 → v2)
3. `docs/app/SPEC-v1.md` — the authoritative build spec
4. `docs/app/DECISIONS.md` and `docs/app/BACKLOG.md` — history and known issues
5. `salvage/compiled-app/out/main/index.js` — how the lost app actually worked (schema, pipeline, IPC channel names, config shape)

Note: the shipped v0.0.1 implemented more than SPEC-v1 (settings windows, setup wizard,
keytar) — where the compiled app and SPEC-v1 disagree, the compiled app reflects later
decisions; check `docs/app/DECISIONS.md` to arbitrate, and ask the user if still unclear.

## Task 1 — code review of the surviving toolkit code

Review `packages/core`, `packages/cli`, `packages/mcp` (and `packages/obsidian` lightly —
it may be retired in the new version). Focus on:

- **Correctness**: token refresh lifecycle in `core/src/auth.ts` (~300-day tokens,
  refresh within 30 days of expiry), error handling on Plaud API calls, the UA-403
  workaround (commit `047deab` added an injectable transport — verify it's sound).
- **Security**: credentials at `~/.plaud/config.json` (mode 0600) — confirm no secrets
  leak into logs or error messages; MCP server exposes recordings to any MCP client.
- **Robustness**: network failure paths, partial downloads in `cli/src/commands/sync.ts`,
  the ENAMETOOLONG fix (`d55b92f`) for un-transcribed recordings.
- **Tests**: `packages/core/test/` exists — run it, extend where the review finds gaps.

## Task 2 — reconstruct `packages/app` as proper TypeScript

Rebuild the Electron app source using:

- `docs/app/SPEC-v1.md` as the spec,
- `salvage/compiled-app/out/main/index.js` as the behavioural reference (it is
  unminified — schema DDL, IPC channel names, config keys, pipeline step order, and the
  Ollama prompt plumbing are all legible in it),
- the surviving `packages/app/electron.vite.config.ts`, `electron-builder.yml`,
  `tsconfig*.json`, `package.json` as the build skeleton,
- `packages/app/python/transcribe.py` and `packages/app/resources/` as-is.

Keep exact compatibility with the existing runtime state so the rebuilt app picks up
where v0.0.1 left off: same SQLite schema as `~/Library/Application Support/distill/state.db`
(read the DDL from the compiled bundle; migrate rather than recreate), same
`config.json` shape, same vocabulary file locations.

## Task 3 — optimisation pass

After parity is reached, optimise — as suggestions first, applied only when agreed:

- Pipeline resumability: every step idempotent and restartable after a crash mid-recording.
- Memory: transcription of long recordings should stream, not buffer whole files.
- Startup: lazy-load renderer windows; the tray must appear fast.
- Dependency diet: review `salvage/compiled-app/package.json` for anything replaceable
  by Node/Electron built-ins.
- Electron/node/better-sqlite3/vite versions: check current stable at build time
  ("Verify" convention from `docs/app/README.md`) — the specs deliberately avoid pinning.

## Constraints (from the decisions log — do not relitigate)

- Local-only: Ollama for summaries, MLX Whisper for transcription. No cloud LLM.
- Inbox-first: nothing processes until manually tagged.
- Self-maintaining features are suggestion-only, never auto-applied.
- Mac-only, Apple Silicon. No mic recording, no multi-user, no search UI.
- **This repo must not live in iCloud Drive.** First step of any new work: confirm the
  working copy is at a local path (e.g. `~/dev/distill`) with GitHub as the sync/backup
  (`https://github.com/sigreenwood/distill`, private), and push early and often.
  Note: `private/` is gitignored — copy `private/MY-VOCAB.md` over manually if starting
  from a fresh clone.

## Verification

- `npm test` at the root (vitest) for core.
- App: run in dev (`electron-vite`), confirm tray appears, poller lists real recordings
  via the stored Plaud JWT, and a tagged recording flows end-to-end to a Markdown file
  in `~/Documents/distill/{client}/`.
- Compare a summarisation run against the same recording processed by installed v0.0.1.
