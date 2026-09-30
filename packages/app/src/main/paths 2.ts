/**
 * Canonical filesystem paths for distill.
 *
 * All app state lives under ~/Library/Application Support/distill/.
 * Logs under ~/Library/Logs/distill/. User-visible Markdown output under
 * whatever the user configures (default ~/Documents/distill/).
 *
 * Back-compat: pre-rename installs stored data under
 * ~/Library/Application Support/Plaud Local/ and ~/Library/Logs/Plaud
 * Local/. If those legacy folders exist and the new ones do not, we
 * keep using them. New installs always use the new paths. The check
 * happens once at module load via existsSync, so the choice is stable
 * for the lifetime of the process. Migration is left to the user (move
 * the folder, rename, restart) since the cost of getting it wrong is
 * loss of state.db.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'distill';
export const LEGACY_APP_NAME = 'Plaud Local';

/**
 * Resolve the Application Support directory once at module load. If a
 * legacy `Plaud Local` directory exists and the new `distill` one does
 * not, prefer the legacy directory so existing installs keep working.
 * Otherwise, always use the new name.
 */
function resolveAppSupportDir(): string {
  const newPath = join(homedir(), 'Library', 'Application Support', APP_NAME);
  const legacyPath = join(homedir(), 'Library', 'Application Support', LEGACY_APP_NAME);
  if (!existsSync(newPath) && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

function resolveLogsDir(): string {
  const newPath = join(homedir(), 'Library', 'Logs', APP_NAME);
  const legacyPath = join(homedir(), 'Library', 'Logs', LEGACY_APP_NAME);
  if (!existsSync(newPath) && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

const APP_SUPPORT_DIR = resolveAppSupportDir();
const LOGS_DIR = resolveLogsDir();

export const appSupportDir = (): string => APP_SUPPORT_DIR;

export const logsDir = (): string => LOGS_DIR;

export const configFile = (): string =>
  join(appSupportDir(), 'config.json');

export const stateDbFile = (): string =>
  join(appSupportDir(), 'state.db');

export const audioDir = (): string =>
  join(appSupportDir(), 'audio');

/**
 * User-writable vocabulary directory. Lives under appSupportDir() so
 * it survives reinstalls (Application Support data is not blown away
 * when /Applications/distill.app is replaced) and is genuinely
 * writable (writing inside the .app bundle is bad practice and may
 * fail on quarantined / signed apps).
 *
 * Populated on first launch by `migrateVocabularyToUserDir()` which
 * copies the bundled JSON files from the .app's read-only
 * Resources/vocabulary/ into here. After first launch, all reads
 * (pipeline transcription) and writes (Settings save, import) go
 * through this directory.
 */
export const userVocabularyDir = (): string =>
  join(appSupportDir(), 'vocabulary');

export const logFile = (): string =>
  join(logsDir(), 'app.log');

/**
 * Expand a leading `~/` in a user-provided path to the home directory.
 * Leaves paths without `~/` untouched.
 */
export const expandHome = (p: string): string =>
  p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
