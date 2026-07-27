# 02 — Repository structure, naming, paths

## 2.1 Product naming

- **Display name**: `distill`
- **Bundle identifier**: `com.distill.app` (Si can pick a different reverse-DNS if he prefers)
- **LaunchAgent label**: `com.distill.app`
- **npm workspace name**: `@distill/app`

These appear in `Info.plist`, the LaunchAgent plist, and tray menu "About" — keep them consistent.

## 2.2 Monorepo layout

Extend the existing `plaud-toolkit/` monorepo. Do not create a separate repo.

```
plaud-toolkit/
├── packages/
│   ├── core/                    (existing — Plaud SDK, reused as-is)
│   ├── cli/                     (existing)
│   ├── mcp/                     (existing)
│   └── app/                 (NEW)
│       ├── package.json
│       ├── tsconfig.json
│       ├── electron.vite.config.ts
│       ├── resources/
│       │   ├── icons/                     (tray icons @1x/@2x, app.icns)
│       │   └── launchd.plist.template
│       ├── python/
│       │   ├── pyproject.toml             (uv-managed dependency manifest)
│       │   ├── transcribe.py              (CLI: audio in → JSON out)
│       │   └── README.md
│       ├── build/
│       │   ├── build-pkg.sh               (produces the .pkg)
│       │   ├── postinstall.sh             (runs inside the .pkg)
│       │   └── entitlements.plist
│       ├── src/
│       │   ├── main/                      (Electron main process, all app logic)
│       │   │   ├── index.ts               (app.whenReady, tray init, wiring)
│       │   │   ├── poller.ts              (Plaud cloud polling)
│       │   │   ├── pipeline.ts            (orchestrates the 4 steps)
│       │   │   ├── steps/
│       │   │   │   ├── download.ts
│       │   │   │   ├── transcribe.ts      (spawns Python)
│       │   │   │   ├── summarise.ts       (Anthropic SDK)
│       │   │   │   └── write-note.ts      (osascript + Markdown)
│       │   │   ├── updater/
│       │   │   │   ├── claude.ts          (polls /v1/models)
│       │   │   │   ├── whisper.ts         (polls HuggingFace)
│       │   │   │   ├── pyannote.ts        (polls HuggingFace)
│       │   │   │   └── index.ts
│       │   │   ├── reflection/
│       │   │   │   ├── reflect.ts         (prompt improvement job)
│       │   │   │   └── diff.ts            (format suggestions as diffs)
│       │   │   ├── state.ts               (SQLite via better-sqlite3)
│       │   │   ├── config.ts
│       │   │   ├── keychain.ts            (secrets via keytar)
│       │   │   ├── tray.ts                (menubar npm + menu template)
│       │   │   ├── windows.ts             (inbox / tag / settings BrowserWindows)
│       │   │   ├── launchd.ts             (install/uninstall the agent)
│       │   │   ├── python-bootstrap.ts    (uv + venv + deps)
│       │   │   ├── seed.ts                (default clients, meeting types)
│       │   │   ├── logger.ts
│       │   │   └── ipc.ts                 (main↔renderer contracts)
│       │   ├── preload/
│       │   │   └── index.ts               (contextBridge)
│       │   └── renderer/                  (React + Vite)
│       │       ├── index.html             (per-window entry points)
│       │       ├── main.tsx
│       │       ├── windows/
│       │       │   ├── Inbox.tsx
│       │       │   ├── Tag.tsx
│       │       │   ├── Settings.tsx
│       │       │   └── FirstRun.tsx
│       │       ├── components/
│       │       └── api.ts                 (typed wrapper over the IPC bridge)
│       └── test/
│           ├── main/
│           └── renderer/
└── docs/
    └── app/                           (THIS FOLDER)
        ├── README.md
        ├── 01-overview.md
        ├── 02-structure.md
        ├── …
        └── PROMPTS.md
```

## 2.3 Filesystem paths (runtime)

The app reads and writes to a small, predictable set of locations.

| Purpose | Path | Created by |
|---|---|---|
| App bundle | `/Applications/distill.app` | `.pkg` installer |
| LaunchAgent plist | `~/Library/LaunchAgents/com.distill.app.plist` | `.pkg` post-install |
| Application Support root | `~/Library/Application Support/distill/` | first run |
| SQLite state | `~/Library/Application Support/distill/state.db` | first run |
| Config (non-secret) | `~/Library/Application Support/distill/config.json` | first run |
| Audio cache | `~/Library/Application Support/distill/audio/{recording_id}.mp3` | pipeline |
| Python venv | `~/Library/Application Support/distill/python/` | first-run wizard |
| Logs | `~/Library/Logs/distill/app.log` (rotated) | logger |
| Markdown backups | `~/Documents/distill/{Client}/{YYYY-MM-DD HH-mm — Title}.md` | write-note step |
| HF model cache | `~/.cache/huggingface/hub/` (default HF location) | Python on first model use |
| Secrets | macOS Keychain, service `com.distill.app` | first-run wizard |

Secrets held in Keychain (via `keytar` or the `security` CLI):

- `anthropic-api-key` — user-provided
- `hf-token` — user-provided
- `plaud-jwt` — already managed by `@plaud/core`; prefer reusing its existing storage rather than duplicating

## 2.4 Icon set

Tray icons:

- `tray-idle.png` / `tray-idle@2x.png` — mic outline, template image (macOS auto-inverts for light/dark menu bar)
- `tray-polling.png` — mic with subtle dot (indicates active poll)
- `tray-processing.png` — mic with filled dot (indicates pipeline running)
- `tray-error.png` — mic with exclamation

Use template images (`Template` suffix in filename, transparent with anti-aliased edges, 16x16 @1x and 32x32 @2x). Electron handles the template rendering automatically when `nativeImage.setTemplateImage(true)` is called.

App icon (`distill.icns`): single 1024×1024 source, use `iconutil` to generate the `.icns` during build. Suggested: stylised mic on a subtle square tile matching macOS app-icon aesthetics.

## 2.5 Monorepo wiring

- Root `package.json`: workspaces stay as-is; the new package is picked up automatically via `packages/*`.
- `packages/app/package.json`:
  - `"name": "@distill/app"`
  - `"dependencies"`: `"@plaud/core": "*"`, plus Electron, `menubar`, `better-sqlite3`, `keytar`, `@anthropic-ai/sdk`, React, etc.
  - `"scripts"`: `dev`, `build`, `build:pkg`, `test`.
- Because `@plaud/core` currently exports `.ts` source files (per its `package.json`), Electron's main process can import it directly through `electron-vite`'s TS support. If that breaks during build, add a build step to `@plaud/core` that emits `.js` to a `dist/` folder and point `"main"` at it.
- Vitest stays the test runner, matching the existing packages.
