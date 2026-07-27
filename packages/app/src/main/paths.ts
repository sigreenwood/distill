import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const APP_NAME = 'distill';
// The app shipped one release as "Plaud Local" before the rename. If a
// legacy directory exists and the new one doesn't, keep using the legacy
// path so existing state (db, audio, vocabulary) carries over untouched.
const LEGACY_APP_NAME = 'Plaud Local';

function resolveAppSupportDir(): string {
  const newPath = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
  const legacyPath = path.join(os.homedir(), 'Library', 'Application Support', LEGACY_APP_NAME);
  if (!fs.existsSync(newPath) && fs.existsSync(legacyPath)) return legacyPath;
  return newPath;
}

function resolveLogsDir(): string {
  const newPath = path.join(os.homedir(), 'Library', 'Logs', APP_NAME);
  const legacyPath = path.join(os.homedir(), 'Library', 'Logs', LEGACY_APP_NAME);
  if (!fs.existsSync(newPath) && fs.existsSync(legacyPath)) return legacyPath;
  return newPath;
}

const APP_SUPPORT_DIR = resolveAppSupportDir();
const LOGS_DIR = resolveLogsDir();

export const appSupportDir = (): string => APP_SUPPORT_DIR;
export const logsDir = (): string => LOGS_DIR;
export const configFile = (): string => path.join(appSupportDir(), 'config.json');
export const stateDbFile = (): string => path.join(appSupportDir(), 'state.db');
export const audioDir = (): string => path.join(appSupportDir(), 'audio');
export const userVocabularyDir = (): string => path.join(appSupportDir(), 'vocabulary');
export const logFile = (): string => path.join(logsDir(), 'app.log');

export const expandHome = (p: string): string =>
  p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
