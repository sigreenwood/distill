# salvage/ — compiled app recovered from the installed bundle

The original TypeScript source of `packages/app` (the distill Electron menu-bar app) was lost
when iCloud Drive corrupted this repo's `.git` directory and deleted most tracked files
(discovered 2026-07-27). No commits containing it survive locally or on GitHub.

`compiled-app/` is extracted from `/Applications/distill.app/Contents/Resources/app.asar`
(distill v0.0.1, built ~2026-04-30). It is the **only surviving copy of the app's logic**:

- `out/main/index.js` — main process bundle, **unminified and readable** (~200KB):
  poller, SQLite schema, pipeline (download → whisper → Ollama summarise → markdown),
  IPC, tray, config, keytar usage — all inspectable with original identifiers.
- `out/preload/index.js` — preload bridge.
- `out/renderer/` — inbox / tag / settings / setup windows (Vite bundles + HTML/CSS).
- `package.json` — the app's runtime dependency list as shipped.

`packages/app/python/` and `packages/app/resources/` in the main tree were also restored
verbatim from the same bundle.

Treat everything here as **read-only reference** for reconstructing proper TypeScript
source. Do not import from or build against it.
