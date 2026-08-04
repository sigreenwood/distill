import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const APP_NAME = 'distill';
/** The app shipped as "Plaud Local" before the rename to distill. */
const LEGACY_APP_NAME = 'Plaud Local';

/** Recorded for the startup log; see migrationNotes(). */
const notes: string[] = [];

/**
 * Resolve a per-user directory, migrating a pre-rename one if found.
 *
 * This used to *fall back* to the legacy path — meaning a Mac that had
 * ever run the old build kept its database, audio, venv and vocabulary
 * under "Plaud Local" permanently, while calling itself distill. A real
 * install was found still doing this months later, which makes support
 * confusing (logs point at a directory the product name never mentions)
 * and leaves two plausible locations for a user to go looking in.
 *
 * Renaming the directory is safe for everything we store. The one thing
 * that would object is the Python venv, whose bin/pip script has an
 * absolute shebang — which is why installVenv invokes `python -m pip`
 * rather than the script.
 *
 * If the rename fails for any reason (permissions, a directory in use)
 * we keep using the legacy path exactly as before. A tidier name is
 * never worth failing to start over.
 */
function resolveDir(base: string[], label: string): string {
  const newPath = path.join(os.homedir(), ...base, APP_NAME);
  const legacyPath = path.join(os.homedir(), ...base, LEGACY_APP_NAME);

  if (fs.existsSync(newPath)) {
    // Both present: the new one wins. Don't merge — that risks a stale
    // legacy state.db silently replacing current data.
    if (fs.existsSync(legacyPath)) {
      notes.push(
        `${label}: both "${APP_NAME}" and "${LEGACY_APP_NAME}" exist; using "${APP_NAME}". ` +
          `The legacy directory is untouched at ${legacyPath} and can be deleted once you have checked it.`,
      );
    }
    return newPath;
  }

  if (!fs.existsSync(legacyPath)) return newPath;

  try {
    fs.renameSync(legacyPath, newPath);
    notes.push(`${label}: migrated "${LEGACY_APP_NAME}" -> "${APP_NAME}".`);
    return newPath;
  } catch (e) {
    notes.push(
      `${label}: could not rename "${LEGACY_APP_NAME}" to "${APP_NAME}" ` +
        `(${e instanceof Error ? e.message : String(e)}); continuing with the legacy path.`,
    );
    return legacyPath;
  }
}

function resolveAppSupportDir(): string {
  return resolveDir(['Library', 'Application Support'], 'app support');
}

function resolveLogsDir(): string {
  return resolveDir(['Library', 'Logs'], 'logs');
}

const APP_SUPPORT_DIR = resolveAppSupportDir();
const LOGS_DIR = resolveLogsDir();

/**
 * What the path migration did, if anything. Emitted once at startup —
 * a silent directory move is exactly the kind of thing that is
 * baffling six months later.
 */
export const migrationNotes = (): string[] => [...notes];

export const appSupportDir = (): string => APP_SUPPORT_DIR;
export const logsDir = (): string => LOGS_DIR;
export const configFile = (): string => path.join(appSupportDir(), 'config.json');
export const stateDbFile = (): string => path.join(appSupportDir(), 'state.db');
export const audioDir = (): string => path.join(appSupportDir(), 'audio');
export const userVocabularyDir = (): string => path.join(appSupportDir(), 'vocabulary');
export const logFile = (): string => path.join(logsDir(), 'app.log');

export const expandHome = (p: string): string =>
  p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
