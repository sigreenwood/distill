# distill — Runbook

Operational reference for the current (pre-installer) state of distill. Covers what to install, in what order, where things live on disk, which ports are in use, what permissions macOS will ask for, and how to recover when something goes wrong.

If you're trying to plan the eventual `.pkg` installer, see `07-install.md` instead — that's design, this is reality.

---

## System requirements

Apple Silicon only, because MLX Whisper only runs on M-series chips. Tested on M4 Pro (48GB) and M5 (24GB); any M1 or later should work but 16GB RAM with the 32B Ollama model will swap heavily. macOS Sequoia or newer is assumed; older releases may work but aren't exercised.

Node.js 22 is the recommended runtime (Node.js 20 also works) for the Electron and app packages. Do not use Node.js 26 or newer: the current `better-sqlite3` version does not build against Node 26's V8 API. The repository includes `.nvmrc` so `nvm use` selects Node 22. Python 3.11 or 3.12 is required for the transcription subprocess — Python 3.13 may work but hasn't been tried. ffmpeg is optional and only needed if you want to drag-and-drop video files (mp4, mov, m4v, mkv, webm) rather than pre-extracted audio.

---

## External dependencies (install these first)

Four things live outside the repo and have to be set up by hand before the app is useful. Install them in roughly this order because each depends on the ones before.

### 1. Ollama

Download and install from `https://ollama.com/download` — a standard macOS `.app` drag-install. Once installed, it runs as a background agent, auto-starts at login, and listens on `http://localhost:11434`. That's the default and it's also what `config.json` points at — no configuration needed unless you want to bind it to a different port (you don't).

Pull the summarisation model:

```sh
ollama pull qwen2.5:32b
```

That downloads ~20 GB to `~/.ollama/models/`. If you want a smaller model for testing on a lower-RAM machine, `qwen2.5:14b` works identically with the same prompts — just change `ollama.model` in `config.json`.

Sanity check: `curl http://localhost:11434/api/tags` should return JSON listing the installed models.

### 2. Plaud CLI auth

The app reuses the same `~/.plaud/config.json` JWT that the CLI creates, so you need to have logged in via the CLI at least once:

```sh
cd ~/plaud-toolkit
npm install
npm --workspace @plaud/cli exec -- plaud login
```

That opens a browser, you authenticate with your Plaud account, and the JWT lands at `~/.plaud/config.json`. The token is long-lived (mine's valid until September 2027) so this is a one-off unless Plaud invalidates it.

Sanity check: `npm --workspace @plaud/cli exec -- plaud list` should show your recordings.

### 3. Python venv for MLX Whisper

Transcription runs as a Python subprocess because MLX is a Python framework. The app package keeps its own venv to avoid polluting system Python:

```sh
cd ~/plaud-toolkit/packages/app/python
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
deactivate
```

First transcription will trigger MLX Whisper to download the `whisper-large-v3-mlx` model (~3 GB) into `~/.cache/huggingface/` — happens automatically, no token needed for this model.

The app code locates the venv by walking through `python/.venv/bin/python`, `python/bin/python`, then falling back to `python3` on PATH — so as long as the venv lives at one of those paths you're fine.

### 4. ffmpeg (optional)

Only needed for video imports. The simplest install:

```sh
brew install ffmpeg
```

The app detects ffmpeg via `which ffmpeg` at import time; if it's absent, video drops will fail with a clear error pointing at this install step, but audio imports and the Plaud polling pipeline both work fine without it.

---

## Building and running the app

From a clean clone:

```sh
cd ~/plaud-toolkit
nvm use
npm ci
npm run --workspace @distill/app rebuild   # rebuilds better-sqlite3 for Electron's ABI
python3 packages/app/scripts/generate-tray-icons.py   # generates tray PNGs
npm run --workspace @distill/app dev
```

If `nvm` is not installed, install Node.js 22 LTS before running `npm ci`. A failed install under Node.js 26 commonly appears as C++ errors such as `no member named 'GetPrototype'` while compiling `better-sqlite3`; switch Node versions and remove `node_modules` before retrying:

```sh
rm -rf node_modules
nvm use 22
npm ci
```

The `rebuild` step is a recurring trap: `better-sqlite3` is a native module and its compiled binary has to match Electron's Node ABI, not the system Node. Running tests (`vitest`) uses system Node, so you can't reuse the same binary. Skip `rebuild` and the app will fail to start with an ABI mismatch; skip a later rebuild after upgrading Electron and same thing.

The `generate-tray-icons.py` step is a one-off per clone — the generated PNGs are committed, but if someone changes the colour scheme or shape they'll need regenerating. Electron 33 on Apple Silicon can't parse SVG data URLs into `nativeImage`, so the PNGs are how the tray icon actually ships.

First start pops up a welcome dialog because no `config.json` exists yet. It writes an `example.config.json` next to where the real one should be; copy it, edit if needed, restart the app.

---

## Network and ports

Only one port matters for day-to-day operation.

| Process | Host | Port | Purpose |
|---|---|---|---|
| Ollama | 127.0.0.1 | 11434 | LLM chat for summarisation |
| Vite dev server (dev only) | 127.0.0.1 | 5173 | Renderer HMR |

Everything else is outbound HTTPS: Plaud's API (`api.plaud.ai`), Hugging Face model downloads on first transcription, and optional LAN-visible printers/drives if you pick a network path for Markdown output.

Nothing exposes a listening port to the LAN. Nothing needs firewall rules. If you're on a corporate VPN that blocks `localhost:11434`, the fix is at the VPN settings — Ollama itself is fine.

---

## File locations reference

All app-managed state lives under macOS-standard paths. Hand-edit these at your own risk; the app assumes their shape.

| Path | What's there |
|---|---|
| `~/Library/Application Support/distill/config.json` | User config. Written by Settings window; safe to edit while app is closed. |
| `~/Library/Application Support/distill/state.db` | SQLite database: recordings, clients, meeting types, app state. |
| `~/Library/Application Support/distill/audio/` | Downloaded MP3 files, keyed by recording id. |
| `~/Library/Application Support/distill/example.config.json` | Starter config written on first run when the real one is missing. |
| `~/Library/Logs/distill/app.log` | Structured JSON logs (pino format). Rolls over at startup. |
| `~/.plaud/config.json` | Plaud CLI's JWT — read by the app, written by `plaud login`. |
| `~/.ollama/models/` | Ollama's model weights. Each model is multi-GB. |
| `~/.cache/huggingface/` | MLX Whisper model weights. ~3 GB after first transcription. |
| `<repo>/packages/app/python/.venv/` | Python venv for MLX Whisper subprocess. |
| `<repo>/packages/app/resources/vocabulary/` | JSON vocabulary files (global, organisation, industry, per-client). On packaged installs these live at `~/Library/Application Support/<app>/vocabulary/` instead. |
| `<repo>/packages/app/resources/icons/` | Generated tray PNGs in four states. |
| User-chosen | Markdown and HTML outputs. Default `~/Documents/distill/`; configurable per destination in Settings. |
| `~/Notes.app` | Apple Notes container. Organised `<ParentFolder>/<Client>/<Note>`. |

Log file is the first thing to check when something's wrong. Follow it with `tail -f` and trigger whatever's failing — pino emits everything as JSON so `| jq` is your friend.

---

## Permissions

macOS asks for three things, all one-off prompts the first time they're needed.

**Notifications** — asked on first startup because the app calls `notify()` when new recordings arrive or summaries complete. Say yes. If you say no and change your mind, System Settings → Notifications → distill.

**Automation / Notes.app** — only asked when Apple Notes output is enabled and a summary first tries to save. You'll see a dialog: "distill wants to control Notes". Say yes. If you accidentally say no, the fix is System Settings → Privacy & Security → Automation → distill → tick Notes.

**Full Disk Access** — not required for the core flows. If you configure Markdown output to write to somewhere macOS treats as protected (Desktop, Documents, Downloads all count on recent macOS), the first write triggers a Finder-mediated permission prompt, not a blocking one. Say yes.

Ollama and the Python subprocess don't need any special permissions — they're local CLIs running in your user context.

---

## Updating

There's no installer or auto-updater yet, so updates mean `git pull` and a rebuild:

```sh
cd ~/plaud-toolkit
git pull
npm install
npm run --workspace @distill/app rebuild
# Restart the dev process
```

If package.json pulled in a new native dep or bumped Electron, `rebuild` is essential. If schema has migrations, they run automatically on app start — check `app.log` for `"migration N applied"` lines to confirm.

If the tray icon colour or shape changed in the commit you pulled, regenerate:

```sh
python3 packages/app/scripts/generate-tray-icons.py
```

Vocabulary changes (global.json, organisation.json, industry.json, client files) take effect on the next transcription without a restart — they're re-read per-job.

Prompt or code changes require the dev process to restart. Main-process changes need a full restart; renderer-only changes pick up via HMR if you stay on the same dev session.

---

## Troubleshooting

### Tray icon missing

If `PLAUD` placeholder text shows but no icon, PNGs haven't been generated. Run `python3 packages/app/scripts/generate-tray-icons.py`. If even the text is missing, check Ice.app (menubar overflow manager) or the MacBook notch — the tray might be rendered but off-screen. The `app.log` will have a `tray icon: SVG produced an empty NativeImage` warning if SVG fallback was hit.

### App won't start, ABI mismatch on better-sqlite3

Run `npm run --workspace @distill/app rebuild`. This rebuilds the native module against Electron's Node ABI. Happens every time Electron version changes.

### Ollama errors in the inbox

`Ollama is not running` means the Ollama.app isn't up or isn't listening on 11434. Open Ollama.app from /Applications. `Ollama model "qwen2.5:32b" is not installed` means you skipped the `ollama pull` step. `Ollama errored during generation` usually means out-of-memory — try a smaller model in `config.json`.

### Transcription crashes or takes forever

Check `app.log` for the Python traceback. The most common causes are a corrupt audio file, the venv missing mlx-whisper (re-install from `requirements.txt`), or the system being OOM on a very long recording. MLX Whisper on M4 Pro 48GB handles 90-minute meetings comfortably; on 16GB machines, 30 minutes is the safer upper bound.

### Apple Notes says "permission denied"

System Settings → Privacy & Security → Automation → distill → tick Notes. If distill doesn't appear in the list, delete the entry for Notes entirely and retry the save; macOS will re-prompt.

### 401 from Plaud on download

JWT expired or revoked. Re-run `plaud login` from the CLI. The the app picks up the new `~/.plaud/config.json` on its next poll without needing a restart.

### Markdown files landing in the wrong folder

Check `outputs.markdown.dir` in `config.json`. The Settings window writes absolute paths after expanding `~`; if you hand-edited and used `~/Documents/...`, the app expands that on load but writes the absolute path back on the next save.

### Changed config.json, app didn't pick it up

The app reads config on startup and when Settings saves. Hand edits to `config.json` while the app is running are ignored. Quit and restart.

---

## Multi-machine notes

Two M-series machines share the same Plaud account but each has its own state DB. A recording is only processed once — whichever machine claims it first via Plaud's API wins, and the other sees it as already-synced. No coordination between machines yet; if you want strict leader/follower, the backlog's dual-machine item covers the plan.

Apple Notes entries land in your iCloud account so both machines see them. Markdown outputs don't sync unless the target folder is itself in iCloud Drive.
