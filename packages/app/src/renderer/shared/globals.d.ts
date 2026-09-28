/**
 * Compile-time globals injected by Vite's `define` (see
 * electron.vite.config.ts). Listing them here so TypeScript knows
 * about them in renderer code without importing anything.
 */

/**
 * The app version, read from packages/app/package.json at build time
 * and substituted in by Vite. Surfaced in the About pane. Falls back
 * to the literal string 'unknown' if package.json couldn't be read
 * during build.
 */
declare const __APP_VERSION__: string;
