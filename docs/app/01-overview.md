# 01 — Overview

## 1.1 Purpose

Replace the Plaud Pro subscription with a local Mac app that:

1. Watches the Plaud cloud for new recordings via the existing `@plaud/core` SDK and JWT.
2. Shows each new recording in an **inbox** — nothing processes automatically.
3. Lets the user tag each recording with a **client** and a **meeting type** from the menu bar. Adding a new client or meeting type is possible inline, not only from Settings.
4. Once tagged: download MP3 → local transcription + diarisation → Claude summary using the prompt bound to that meeting type → writes an Apple Note under the client folder with summary above, transcript below. Also writes a Markdown backup to `~/Documents/distill/`.
5. Installs via a double-click `.pkg`, launches at login via `launchd`, deployable across several Macs without terminal steps.
6. Periodically checks for newer Claude / Whisper / pyannote models and suggests prompt improvements based on recent output — always with user approval before anything changes.

## 1.2 In scope (v1)

- Poll Plaud cloud, populate inbox, macOS notification per new recording.
- Manual tag per recording: client + meeting type, both editable/addable inline.
- Local Whisper transcription with pyannote speaker diarisation.
- Summary via Anthropic API with per-meeting-type prompt.
- Apple Notes output, filed by client folder, summary-then-transcript layout, plus Markdown backup on disk.
- `.pkg` installer, ad-hoc signed, no Apple Developer Program.
- Launch on login via `launchd` LaunchAgent.
- Settings UI: clients, meeting types (including prompt editor), API keys, poll interval, pause.
- Per-note rating (👍 / 👎) feeding the prompt improvement loop.
- Weekly model-update check. New models appear as suggestions, never auto-applied.
- Periodic prompt-improvement reflection. Suggestions appear as diffs in Settings; user accepts, edits, or dismisses.

## 1.3 Out of scope (v1, explicit)

Keep these out unless the contributor asks for them later.

- Auto-classifying the client from transcript content.
- Pre-tagging / queued tags for recordings that haven't synced yet.
- Recording from the Mac microphone.
- USB direct-from-device import as a fallback for cloud sync.
- Windows or Linux builds.
- Sharing, multi-user, team features.
- Search across notes (Apple Notes has its own search).
- Auto-applying model or prompt updates. Everything self-maintaining is suggestion-only.

## 1.4 Critical risk — verify before cancelling the Plaud Pro subscription

The entire design depends on the Plaud device continuing to sync recordings up to Plaud cloud *without* a Pro sub. This is a Plaud billing/product question, not a code question. If cloud sync turns out to be Pro-gated, v1 is non-functional and a USB-pull fallback would be needed.

**Recommended check before rollout**: let the current Pro sub lapse for a week while keeping recordings active, and verify via the existing `distill` CLI that new recordings still appear via `listRecordings()`. Don't build v1 until this is confirmed or a fallback is in scope.

## 1.5 Architecture

```
Plaud cloud (api.plaud.ai, JWT auth via @plaud/core)
        │ HTTP poll every N min
        ▼
┌─────────────────────────────────────────────────────────┐
│ distill — one Electron process, TypeScript          │
│                                                          │
│  Poller ──► SQLite ──► Inbox UI ──► Tag sheet ──► Queue │
│                                                   │      │
│  Pipeline steps (sequential, resumable):          │      │
│    1. Download MP3                                │      │
│    2. Spawn Python: mlx-whisper + pyannote        │      │
│    3. Anthropic SDK — summary                     │      │
│    4. osascript — Apple Notes                     │      │
│    5. Write Markdown backup                       │      │
│                                                          │
│  Background: weekly update checks + prompt reflection   │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
        Apple Notes  +  ~/Documents/distill/*.md
```

Key shape decisions, with reasoning:

- **TypeScript everywhere except transcription.** `@plaud/core` is TS, Electron is TS, Anthropic SDK is first-class in TS, Electron has mature menu bar and IPC patterns. Only MLX Whisper and pyannote require Python — they run as a child process.
- **New package in the existing monorepo**: `packages/app`, workspace-depending on `@plaud/core`. Keeps everything in one repo, one version, one test run.
- **Single always-on Electron process**, started by `launchd`. All pipeline work happens inside it. No separate daemon.
- **Python managed by `uv`**, installed during first-run if absent. Python runtime is NOT bundled in the `.pkg` — keeps the installer under ~250MB instead of ~1.5GB, and `uv` handles Python upgrades, venv isolation, and dependency resolution faster than pip. Verify current install command at https://docs.astral.sh/uv/. **Verify**.
- **Electron + `menubar` npm package** for the tray UI. Electron is heavy but the only mature TS/Node route for a macOS menu bar with native notifications, tray, and a renderer for Settings. Verify `menubar` is still actively maintained — if not, implementing the tray directly on `electron.Tray` is straightforward. **Verify**.
- **better-sqlite3** for storage. Synchronous API, zero setup, electron-rebuilds cleanly, widely used.
- **Suggestion-only for everything self-maintaining.** Model and prompt updates never apply automatically, because: model output format can change between versions; prompt edits change the shape of the Apple Note the user has been reading for months. User approval is the guardrail.

## 1.6 Non-goals of this document

This spec does not prescribe exact package versions, specific model IDs for Claude or pyannote (those move), or the final AppleScript syntax for Apple Notes (test at build time). Where versions are named, treat them as starting points to verify.
