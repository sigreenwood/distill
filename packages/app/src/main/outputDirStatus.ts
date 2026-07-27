import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expandHome } from './paths.js';

export interface OutputDirStatus {
  /** The path after ~ expansion — what the pipeline will actually use. */
  resolvedPath: string;
  exists: boolean;
  writable: boolean;
  /** Doesn't exist yet, but the nearest existing ancestor is writable. */
  willBeCreated: boolean;
  /** Path lives inside iCloud Drive, so outputs sync between Macs. */
  inICloudDrive: boolean;
  /** Markdown files already present (0 when the folder doesn't exist). */
  existingSummaries: number;
  /** Human-readable blocker, or null when the destination is usable. */
  problem: string | null;
  /** Non-blocking note worth showing (e.g. cross-machine implications). */
  note: string | null;
}

function iCloudDriveRoot(): string {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
}

/** Nearest ancestor that exists, for judging whether we could create the dir. */
function nearestExistingAncestor(p: string): string | null {
  let current = path.dirname(p);
  // Walk up until something exists or we hit the filesystem root.
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function countMarkdown(dir: string): number {
  // The pipeline writes to <dir>/<client>/<file>.md, so count one level
  // down as well as the top level.
  let n = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) n++;
      else if (entry.isDirectory()) {
        try {
          n += fs
            .readdirSync(path.join(dir, entry.name))
            .filter((f) => f.toLowerCase().endsWith('.md')).length;
        } catch {
          // unreadable client subfolder — not worth failing the check over
        }
      }
    }
  } catch {
    return 0;
  }
  return n;
}

/**
 * Inspect an output destination so Settings can tell the user what will
 * actually happen, rather than leaving them to discover after a
 * pipeline run that nothing appeared.
 *
 * Note the folder legitimately doesn't exist until the first successful
 * write — the write step creates it recursively. "Will be created" is a
 * normal, healthy state, not a warning.
 */
export function inspectOutputDir(rawPath: string): OutputDirStatus {
  const resolvedPath = expandHome((rawPath ?? '').trim());
  const base: OutputDirStatus = {
    resolvedPath,
    exists: false,
    writable: false,
    willBeCreated: false,
    inICloudDrive: false,
    existingSummaries: 0,
    problem: null,
    note: null,
  };

  if (resolvedPath.length === 0) {
    return { ...base, problem: 'No folder set.' };
  }
  if (!path.isAbsolute(resolvedPath)) {
    return { ...base, problem: `Not an absolute path: "${resolvedPath}".` };
  }

  const inICloudDrive = resolvedPath.startsWith(iCloudDriveRoot());
  const exists = fs.existsSync(resolvedPath);

  if (exists) {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isDirectory()) {
      return { ...base, inICloudDrive, problem: 'That path is a file, not a folder.' };
    }
    const writable = isWritable(resolvedPath);
    return {
      ...base,
      exists: true,
      writable,
      inICloudDrive,
      existingSummaries: countMarkdown(resolvedPath),
      problem: writable ? null : 'The folder exists but is not writable.',
      note: inICloudDrive
        ? 'In iCloud Drive — summaries sync to your other Macs, and distill can detect recordings already processed there.'
        : null,
    };
  }

  const ancestor = nearestExistingAncestor(resolvedPath);
  if (!ancestor) {
    return { ...base, inICloudDrive, problem: 'No part of that path exists.' };
  }
  if (!isWritable(ancestor)) {
    return {
      ...base,
      inICloudDrive,
      problem: `Cannot create the folder — "${ancestor}" is not writable.`,
    };
  }
  return {
    ...base,
    willBeCreated: true,
    writable: true,
    inICloudDrive,
    note: inICloudDrive
      ? 'Will be created in iCloud Drive on the first summary.'
      : 'Will be created on the first summary.',
  };
}
