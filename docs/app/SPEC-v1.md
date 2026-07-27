# SPEC — v1 minimal

**Target**: Claude Code (or manual implementation), building v1 end-to-end.
**Scope**: minimum viable version of the menu bar app. Fully local, no cloud APIs, no installer, no Apple Notes, no diarisation, no self-maintaining.
**Success criterion**: Si can run the app on his Mac, Plaud recordings appear in an inbox, he tags each with client + meeting type, and a Markdown file appears in `~/Documents/distill/{client}/` with a local-LLM-generated summary on top and the Whisper transcript below.

Everything beyond this scope is deferred — see `ROADMAP.md`.

---

## 1. Critical precondition

Before building, verify that **Plaud device recordings still sync to Plaud cloud without an active Pro subscription**. Use the existing `distill` CLI:

```bash
cd packages/cli
pnpm start listRecordings
```

After the contributor's next Plaud dock with Pro lapsed, new recordings from that session must appear in the list. If they don't, v1 is not viable and a USB-pull fallback is needed — stop and raise with the contributor.

## 2. Architecture

```
Plaud cloud ──► Poller ──► SQLite (inbox) ──► User tags via tray ──►
  ──► Download MP3 ──► Python subprocess (MLX Whisper) ──►
  ──► Ollama (localhost:11434) ──► Markdown file on disk
```

One Electron process. TypeScript. `@plaud/core` reused as a workspace dependency. Everything runs on the Mac — no external APIs, no keys, no cloud dependencies at runtime. The only network traffic is (a) Plaud cloud for recording metadata and MP3 downloads, (b) Ollama model registry for pulling the LLM, one-time.

Key v1 simplifications vs the full spec:
- **No diarisation** — Whisper transcript only, no pyannote, no HuggingFace token.
- **No Apple Notes** — Markdown file to disk is the output.
- **No installer** — run via `pnpm dev` or an unsigned `.app` from `pnpm build`.
- **No LaunchAgent** — user starts the app manually.
- **No secrets management** — no API keys anywhere; Ollama is local.
- **No first-run wizard** — user copies an `example.config.json` and fills in values.
- **No self-maintaining** — no model update checks, no reflection.
- **No React Settings window** — `config.json` is the settings UI for v1.

What remains:
- Always-on process, polling Plaud every 5 minutes.
- Minimal tray menu: inbox count, "Sync now", "Open inbox", "Pause polling", "Quit".
- Inbox window: list of untagged recordings with "Tag & process" and "Skip".
- Tag sheet: client dropdown (+ add new), meeting type dropdown (+ add new), save.
- Pipeline: download → transcribe → summarise via Ollama → Markdown file.
- Error handling: retry up to 3 times per step with backoff, surface errors in tray.
- Logging to `~/Library/Logs/distill/app.log`.

## 3. Repository layout

Add one new package to the existing monorepo:

```
plaud-toolkit/
└── packages/
    └── app/                       (NEW)
        ├── package.json
        ├── tsconfig.json
        ├── electron.vite.config.ts
        ├── python/
        │   ├── pyproject.toml
        │   ├── transcribe.py
        │   └── requirements.txt
        ├── resources/
        │   ├── icons/
        │   │   ├── trayTemplate.png   (16x16)
        │   │   └── trayTemplate@2x.png
        │   └── example.config.json
        ├── src/
        │   ├── main/
        │   │   ├── index.ts           (app.whenReady, tray init)
        │   │   ├── poller.ts
        │   │   ├── pipeline.ts
        │   │   ├── steps/
        │   │   │   ├── download.ts
        │   │   │   ├── transcribe.ts
        │   │   │   ├── summarise.ts   (calls Ollama)
        │   │   │   └── write-markdown.ts
        │   │   ├── state.ts           (SQLite)
        │   │   ├── config.ts
        │   │   ├── seed.ts
        │   │   ├── tray.ts
        │   │   ├── windows.ts         (inbox + tag)
        │   │   ├── ipc.ts
        │   │   └── logger.ts
        │   ├── preload/
        │   │   └── index.ts
        │   └── renderer/
        │       ├── inbox/
        │       │   ├── index.html
        │       │   └── Inbox.tsx
        │       └── tag/
        │           ├── index.html
        │           └── Tag.tsx
        └── test/
```

## 4. Data model

Database at `~/Library/Application Support/distill/state.db`. Use `better-sqlite3` (synchronous, native, electron-rebuilds cleanly).

```sql
CREATE TABLE recordings (
  id                TEXT PRIMARY KEY,     -- Plaud file_id
  filename          TEXT NOT NULL,
  duration_seconds  INTEGER,
  start_time        INTEGER,              -- epoch seconds
  filesize_bytes    INTEGER,
  synced_at         INTEGER NOT NULL,     -- epoch ms
  status            TEXT NOT NULL,        -- inbox | tagged | downloading | transcribing | summarising | writing | complete | error | skipped
  client_id         TEXT REFERENCES clients(id),
  meeting_type_id   TEXT REFERENCES meeting_types(id),
  audio_path        TEXT,
  transcript_text   TEXT,
  summary_text      TEXT,
  markdown_path     TEXT,
  error             TEXT,
  last_step         TEXT,
  retries           INTEGER NOT NULL DEFAULT 0,
  prompt_snapshot   TEXT,
  model_snapshot    TEXT,                 -- Ollama model used, e.g. "qwen2.5:32b"
  whisper_snapshot  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE clients (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE meeting_types (
  id          TEXT PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  prompt      TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE INDEX idx_recordings_status    ON recordings(status);
CREATE INDEX idx_recordings_synced_at ON recordings(synced_at DESC);
```

Seed on first run:

- Clients: none. Users add their own from the tag sheet's "+ Add new client…" affordance.
- Meeting types: none. Users add their own from Settings -> Prompts -> "Add new prompt". Prompts in `PROMPTS.md` remain on disk for the "Revert to default" path on contributor machines that ran older seeded versions, but are no longer applied to fresh installs.

## 5. Configuration

`~/Library/Application Support/distill/config.json`:

```json
{
  "version": 1,
  "ollama": {
    "host": "http://localhost:11434",
    "model": "qwen2.5:32b",
    "contextWindow": 32768,
    "temperature": 0.3,
    "keepAlive": "24h"
  },
  "pollIntervalMinutes": 5,
  "paused": false,
  "whisperModel": "mlx-community/whisper-large-v3-mlx",
  "markdownBaseDir": "~/Documents/distill",
  "audioRetentionDays": 14,
  "logLevel": "info"
}
```

**Per-Mac defaults** (ship these in `example.config.json` and let the user pick or detect):

| Mac | Recommended `ollama.model` | Why |
|---|---|---|
| 48GB (M4) | `qwen2.5:32b` | ~20GB footprint, best summary quality on the tier, ~15-25 tok/s |
| 24GB (M5) | `qwen3:14b` | ~9GB footprint, strong for its size, ~30-50 tok/s |

Both assume Q4_K_M quantisation (Ollama default). On the 24GB Mac, `qwen2.5:32b` will run but will swap aggressively — avoid.

**Verify** at build time:
- Current Qwen tags on Ollama registry at `https://ollama.com/library`. Qwen moves fast (`qwen2.5`, `qwen3`, `qwen3.5` all exist in different tiers). Pick whatever's current and stable.
- Current `mlx-community/whisper-large-v3-mlx` HuggingFace repo still exists. If a `turbo` variant is stable, prefer it (faster, marginal quality cost).

On first launch, if `config.json` doesn't exist: write `example.config.json` next to it and exit with a tray notification pointing the user at the file. No wizard in v1.

## 6. Pipeline

### 6.1 Poll (every `pollIntervalMinutes`)

```ts
const list = await plaudClient.listRecordings();
for (const r of list) {
  if (!db.recordingExists(r.id)) {
    db.insert({
      id: r.id,
      filename: r.filename,
      duration_seconds: r.duration,
      start_time: r.start_time,
      filesize_bytes: r.filesize,
      synced_at: Date.now(),
      status: 'inbox',
      ...
    });
    notify(`New recording: ${r.filename}`);
  }
}
```

On list failure: log, backoff, retry on next cycle.

### 6.2 Tag (user action)

User clicks "Tag & process" in the inbox window. Tag sheet opens. User picks client + meeting type (or adds a new one). On save:

```ts
db.update(id, { client_id, meeting_type_id, status: 'tagged' });
pipeline.enqueue(id);
```

### 6.3 Pipeline worker

FIFO, concurrency 1. For each tagged recording: `downloading → transcribing → summarising → writing → complete`. On error at any step: `status='error'`, `last_step=<step>`, surface to user.

Retries: 3 attempts per step with backoff 5s / 30s / 2min for transient errors (network, 5xx, Ollama not responding). Permanent errors (model not installed, corrupt audio) go straight to error state.

On app restart: any recordings stuck in in-flight states get resumed from their last step.

### 6.4 Download step

```ts
const url = await plaudClient.getMp3Url(r.id);
if (!url) throw new Error('No MP3 URL yet — try again later');
const out = path.join(appSupport, 'audio', `${r.id}.mp3`);
await streamFetchToFile(url, out);
const size = (await fs.stat(out)).size;
if (size < 1024) throw new Error(`File too small: ${size}`);
db.update(r.id, { audio_path: out });
```

### 6.5 Transcribe step

Spawn the Python CLI in the managed venv:

```ts
const args = [
  path.join(app.getAppPath(), 'python', 'transcribe.py'),
  '--audio', r.audio_path,
  '--whisper-model', config.whisperModel,
];
const { stdout } = await runChild(pythonBin, args);
const result = JSON.parse(stdout);
db.update(r.id, {
  transcript_text: result.text,
  whisper_snapshot: result.model,
});
```

`transcribe.py` contract (no diarisation in v1):

- Input: `--audio <path> --whisper-model <model_id>`. Optional `--language <lang>`.
- Output: JSON on stdout:

```json
{
  "text": "Full transcript as plain text, one paragraph per detected pause…",
  "language": "en",
  "model": "mlx-community/whisper-large-v3-mlx",
  "duration_seconds": 1823.4
}
```

- Progress on stderr, one JSON line per update: `{"phase":"transcribe","progress":0.42}`.

Use MLX Whisper. Word-level timestamps not required in v1. Paragraph breaks: insert a newline on detected silences over ~1.5s, or simply after every ~15 Whisper segments.

Python dependencies (`requirements.txt`):
- `mlx-whisper` (latest stable)
- `numpy`, `soundfile` (transitive)

**Verify** exact versions at build time.

### 6.6 Summarise step (Ollama)

Ollama exposes an HTTP API on `http://localhost:11434`. The native endpoint is `/api/chat`; there's also an OpenAI-compatible endpoint at `/v1/chat/completions`. Use the native one for clarity.

```ts
async function summariseStep(r: Recording) {
  const meetingType = db.getMeetingType(r.meeting_type_id);
  const client = db.getClient(r.client_id);

  const userMessage = [
    `<context>`,
    `Client: ${client.name}`,
    `Meeting type: ${meetingType.name}`,
    `Date: ${new Date(r.start_time * 1000).toISOString()}`,
    `Duration: ${formatDuration(r.duration_seconds)}`,
    `</context>`,
    ``,
    `<transcript>`,
    r.transcript_text,
    `</transcript>`,
    ``,
    `Produce the output exactly as specified in the system prompt.`,
  ].join('\n');

  const response = await fetch(`${config.ollama.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ollama.model,
      messages: [
        { role: 'system', content: meetingType.prompt },
        { role: 'user', content: userMessage },
      ],
      stream: false,
      keep_alive: config.ollama.keepAlive,
      options: {
        num_ctx: config.ollama.contextWindow,
        temperature: config.ollama.temperature,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama ${response.status}: ${body.slice(0, 500)}`);
  }

  const result = await response.json() as { message: { content: string } };
  const summary = result.message.content;

  db.update(r.id, {
    summary_text: summary,
    prompt_snapshot: meetingType.prompt,
    model_snapshot: config.ollama.model,
  });
}
```

Notes:
- `keep_alive: "24h"` tells Ollama to keep the model resident in memory between requests. Without this, the model unloads after 5 minutes of idle, meaning the next summary pays a ~10-30s cold-start penalty. With it, subsequent summaries start generating immediately.
- `num_ctx: 32768` allows transcripts up to ~24k tokens (a 2-3 hour meeting). Qwen models support up to 128k — raise if longer recordings are routine, but larger context costs more memory and latency.
- `temperature: 0.3` gives deterministic-ish output. Raise to 0.5-0.7 if summaries feel mechanical.
- Streaming is off for simplicity. Flipping `stream: true` is a v1.1 improvement for showing progress.

### 6.7 Pre-flight checks

Before processing starts, verify Ollama is reachable and the model is pulled. On app start and before each pipeline run:

```ts
async function verifyOllama(): Promise<void> {
  try {
    const r = await fetch(`${config.ollama.host}/api/tags`);
    const data = await r.json() as { models: Array<{ name: string }> };
    const has = data.models.some(m => m.name === config.ollama.model);
    if (!has) {
      throw new Error(
        `Ollama is running but the model "${config.ollama.model}" is not installed. ` +
        `Pull it with: ollama pull ${config.ollama.model}`
      );
    }
  } catch (e: any) {
    if (e.code === 'ECONNREFUSED') {
      throw new Error(
        `Ollama is not running. Start the Ollama app from /Applications, or run: ollama serve`
      );
    }
    throw e;
  }
}
```

Run this at app startup; surface failures clearly in the tray ("Ollama: not running" or "Ollama: model missing") with a link to the troubleshooting guide in the README. Don't enqueue pipeline work while Ollama is unavailable.

### 6.8 Write Markdown step

Path: `{markdownBaseDir}/{client name}/{YYYY-MM-DD HH-mm} — {sanitised filename}.md`

Create directories as needed. Sanitise filename: strip `/`, `\`, `:`, control characters.

Content:

```markdown
---
client: Acme Corp
meeting_type: Client Call
recorded: 2026-04-21T14:30:00Z
duration: 52m 14s
plaud_id: abc123
model: qwen2.5:32b
whisper: mlx-community/whisper-large-v3-mlx
---

# Summary

{summary text}

---

# Transcript

{transcript text}
```

After write, set `status='complete'`, `markdown_path=<out>`, fire a macOS notification: `"{client} — {meeting_type}: summary ready"` with an action to reveal the file in Finder.

## 7. Tray menu (minimal)

Template:

```
Status: Last sync 2m ago · 3 in inbox    (disabled, informational)
────────────────────────────────────
Inbox (3)…                               (opens inbox window)
Recent                            ▸      (submenu: last 5 complete; click reveals .md in Finder)
────────────────────────────────────
Sync now
Pause polling / Resume polling
────────────────────────────────────
Errors (1)…                              (only shown when errors > 0)
Ollama: not running                      (only shown when pre-flight fails)
────────────────────────────────────
Open logs
Open config folder
Quit
```

Tray icon: single template image. Badge text shows inbox count when > 0.

## 8. Inbox window

Small `BrowserWindow`, 480×640, opens below the tray. React renderer. Lists recordings with `status='inbox'`, newest first. Each row:

- Filename
- Relative time (e.g. "Today 14:30") + duration
- "Tag & process" button → opens tag sheet
- "Skip" button → sets status to `skipped`

Empty state: "No recordings waiting. New recordings appear here when Plaud syncs."

Footer: count + "Show skipped" toggle.

## 9. Tag sheet

Modal `BrowserWindow`, 420×360. Two dropdowns:

- **Client** (searchable combobox): all clients sorted, plus `+ Add new…` at the bottom. Adding requires unique non-empty name.
- **Meeting type** (searchable combobox): all meeting types, plus `+ Add new…`. Adding opens a sub-panel with name + prompt textarea; both required.

Buttons: `Save & process` (⌘↩), `Cancel` (Esc).

On save: persist, set `status='tagged'`, enqueue pipeline, close sheet.

## 10. Environment setup (per Mac)

v1 assumes the contributor runs these steps manually on each Mac before `pnpm dev`. A proper installer arrives in v1.1.

### 10.1 Ollama

```bash
# Install Ollama (one-liner from ollama.com — verify the current URL)
curl -fsSL https://ollama.com/install.sh | sh

# Ollama installs as /Applications/Ollama.app with a menu bar icon.
# The daemon runs automatically in the background.

# Pull the right model for this Mac (see §5 per-Mac defaults)
# On the 48GB M4:
ollama pull qwen2.5:32b
# On the 24GB M5:
ollama pull qwen3:14b

# Smoke test
curl http://localhost:11434/api/generate -d '{"model":"qwen2.5:32b","prompt":"hello","stream":false}'
```

Expect the first model response to take 10-30s as the model loads into memory. Subsequent requests start immediately while `keep_alive` holds it resident.

### 10.2 Python (for Whisper)

```bash
# Install uv if absent (from docs.astral.sh/uv — verify the current URL)
curl -LsSf https://astral.sh/uv/install.sh | sh

# From the repo
cd packages/app
uv venv python --python 3.12
uv pip install --python python/bin/python -r python/requirements.txt
```

First Whisper transcription downloads the model to `~/.cache/huggingface/hub/` (~3GB).

### 10.3 Node / pnpm

Existing monorepo already uses `pnpm`. No extra setup.

### 10.4 Config

```bash
mkdir -p ~/Library/Application\ Support/Plaud\ Local
cp packages/app/resources/example.config.json \
   ~/Library/Application\ Support/Plaud\ Local/config.json
# Edit config.json — set ollama.model to match this Mac's capability
```

## 11. Build and run

### Dev mode

```bash
cd plaud-toolkit
pnpm install
pnpm --filter @distill/app dev
```

Expects `~/Library/Application Support/distill/config.json` to exist and Ollama to be reachable. On startup, pre-flight checks (§6.7) will complain loudly if either is missing.

### Production build (local only, not a .pkg)

```bash
pnpm --filter @distill/app build
```

Produces `packages/app/dist/distill.app`. Double-click to run. macOS will prompt "unidentified developer" — right-click → Open once per Mac.

Installer + LaunchAgent are v1.1.

## 12. Errors, logging

Log file: `~/Library/Logs/distill/app.log`. Rotating at 5MB × 5 files. Default level `info`.

Log at info: poll results, pipeline step outcomes, Ollama pre-flight results. Log at debug: Plaud responses (no tokens), Python stdout/stderr, Ollama request/response sizes (not bodies). Never log: Plaud JWT, transcript content, summary content.

Errors surface in tray under "Errors (N)". Each entry has Retry and Skip. Retry resumes from the failed step.

Ollama-specific errors to handle explicitly:
- **Connection refused** → "Ollama is not running. Start the Ollama app."
- **Model not found** (`/api/tags` lacks the configured model) → "Run `ollama pull {model}` in Terminal."
- **Context too small** (Ollama returns truncated-looking output) → log the transcript length; user may need to raise `num_ctx` or switch meeting types.
- **Out of memory** (Ollama kills the process) → the 24GB Mac can hit this if too many apps are open; log and surface with a clear message.

## 13. Testing

Minimum:

- Unit tests (vitest) for: SQLite migrations, config loader, seed loader, state machine transitions, transcript-to-paragraph splitter, Markdown file writer path sanitisation, Ollama pre-flight check.
- Integration test: mock Plaud SDK + mock Ollama server (a small fixture that replies with a fake summary) + real Python against a bundled 10-second `.wav` → assert Markdown file exists with expected content shape.
- Manual smoke checklist:
  1. Fresh setup: Ollama running, model pulled, config written. `pnpm dev`. Tray appears.
  2. Real Plaud recording syncs → appears in inbox within one poll.
  3. Tag as a client / meeting type → processes → Markdown file appears. First summary may take 10-30s longer (cold start); second is fast.
  4. Kill Ollama (quit the app) → pre-flight fails → tray shows "Ollama: not running" → pipeline pauses.
  5. Restart Ollama → pre-flight passes → queued recordings process.
  6. Add a new client from the tag sheet → recording uses it; file path reflects it.
  7. Pause polling → no new recordings enter inbox. Resume → they appear.
  8. Kill app mid-transcribe → restart → resumes.

## 14. Known limitations of v1

Document these in the README so the contributor isn't surprised:

- **Summary quality is below Claude Sonnet.** Qwen 2.5 32B on the M4 is genuinely capable for summarisation and structured output, but the heavily-structured committee minutes prompt may produce weaker attribution and formatting than Claude would. The `client-call`, `training`, and `all-hands` prompts should work well.
- **Output style varies between Macs.** M4 (Qwen 32B) and M5 (Qwen 14B) will produce slightly different-flavoured summaries. Not wrong, just different. Consistency arrives if both Macs run the same model.
- **First summary after a Mac sleep or Ollama restart is slow** (~10-30s cold start). Subsequent summaries run at full speed.
- **Ollama must be running.** If it's not, the pipeline stops with a clear tray message. No automatic restart of Ollama in v1.
- **No speaker attribution.** Single continuous transcript. the committee minutes prompt works from textual context only; attribution quality will be limited until v1.2 adds diarisation.
- **No autostart.** App doesn't launch at login in v1. Either keep it in your Dock or add it to Login Items manually. Ollama's own menu bar app starts at login by default — that part is handled.
- **No installer.** Installing on another Mac means repeating §10 on that Mac. Proper `.pkg` installer arrives in v1.1.
- **No Settings UI.** Configuration changes require editing `config.json` and restarting.
- **No rating, no prompt suggestions.** Deferred to later phases.

## 15. Acceptance criteria

Claude Code (or the contributor, building manually) has finished v1 when, on the contributor's Mac:

1. Ollama is installed and the configured model is pulled.
2. `pnpm --filter @distill/app dev` starts the app, tray icon appears.
3. Pre-flight check passes (tray shows idle, not "Ollama: not running").
4. Within one poll cycle of a real Plaud sync, new recordings appear in the inbox.
5. Tagging a recording with client + meeting type kicks off the pipeline.
6. For a typical 30-60 minute recording, within ~10-20 minutes the pipeline completes and a Markdown file exists at `~/Documents/distill/{client}/...md` with a coherent summary (using the relevant meeting-type prompt) on top and the Whisper transcript below.
7. Errors during any step surface in the tray "Errors (N)" submenu with a working retry.
8. Adding a new client or meeting type from the tag sheet persists and appears in subsequent tag sheets.
9. Quit and relaunch: in-flight recordings resume; untagged recordings stay in inbox.
10. All unit and integration tests pass.

Once those are green, v1 is done and v1.1 planning starts.
