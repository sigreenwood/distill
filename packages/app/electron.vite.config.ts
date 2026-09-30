import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

// @plaud/core ships raw TypeScript (no build step, package.json main points at
// src/index.ts). We bundle it into the main process so Electron doesn't try to
// require() the .ts files at runtime. Everything else — including native
// modules like better-sqlite3 — stays external as normal.
const bundledWorkspacePkgs = ['@plaud/core'];

// Read the app version from package.json at build time so the About pane
// can surface it without any runtime IPC plumbing. We inject this as the
// global `__APP_VERSION__` via Vite's `define` (compile-time string
// substitution). If anything goes wrong reading package.json the build
// just bakes in 'unknown' rather than failing — the version is
// non-critical UI copy.
let appVersion = 'unknown';
try {
  const pkg = JSON.parse(
    readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
  ) as { version?: string };
  if (typeof pkg.version === 'string' && pkg.version.length > 0) {
    appVersion = pkg.version;
  }
} catch {
  // fall through to 'unknown'
}
const defineGlobals = {
  __APP_VERSION__: JSON.stringify(appVersion),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePkgs })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePkgs })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    define: defineGlobals,
    build: {
      rollupOptions: {
        input: {
          inbox: resolve(__dirname, 'src/renderer/inbox/index.html'),
          tag: resolve(__dirname, 'src/renderer/tag/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
          setup: resolve(__dirname, 'src/renderer/setup/index.html'),
          history: resolve(__dirname, 'src/renderer/history/index.html'),
          reader: resolve(__dirname, 'src/renderer/reader/index.html'),
          brief: resolve(__dirname, 'src/renderer/brief/index.html'),
          register: resolve(__dirname, 'src/renderer/register/index.html'),
        },
      },
    },
    server: {
      // electron-vite serves the renderer on this port in dev mode
      port: 5173,
    },
  },
});
