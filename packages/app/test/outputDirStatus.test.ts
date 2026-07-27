import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inspectOutputDir } from '../src/main/outputDirStatus.js';

describe('inspectOutputDir', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-outdir-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('reports an existing writable folder as usable', () => {
    const s = inspectOutputDir(tmp);
    expect(s.exists).toBe(true);
    expect(s.writable).toBe(true);
    expect(s.problem).toBeNull();
  });

  it('treats a not-yet-created folder as healthy, not an error', () => {
    // The write step creates the directory recursively, so "missing" is
    // the normal state before the first summary lands.
    const s = inspectOutputDir(path.join(tmp, 'distill'));
    expect(s.exists).toBe(false);
    expect(s.willBeCreated).toBe(true);
    expect(s.problem).toBeNull();
  });

  it('counts markdown in the folder and one level of client subfolders', () => {
    fs.writeFileSync(path.join(tmp, 'top.md'), '#');
    fs.mkdirSync(path.join(tmp, 'HSBC'));
    fs.writeFileSync(path.join(tmp, 'HSBC', 'a.md'), '#');
    fs.writeFileSync(path.join(tmp, 'HSBC', 'b.md'), '#');
    fs.writeFileSync(path.join(tmp, 'HSBC', 'notes.txt'), 'ignored');
    expect(inspectOutputDir(tmp).existingSummaries).toBe(3);
  });

  it('rejects a path that is a file', () => {
    const file = path.join(tmp, 'a-file');
    fs.writeFileSync(file, 'x');
    expect(inspectOutputDir(file).problem).toMatch(/file, not a folder/i);
  });

  it('rejects an empty or relative path', () => {
    expect(inspectOutputDir('').problem).toMatch(/no folder set/i);
    expect(inspectOutputDir('relative/path').problem).toMatch(/absolute/i);
  });

  it('expands ~ so the reported path is what the pipeline will use', () => {
    const s = inspectOutputDir('~/Documents/distill');
    expect(s.resolvedPath).toBe(path.join(os.homedir(), 'Documents', 'distill'));
    expect(s.resolvedPath.startsWith('~')).toBe(false);
  });

  it('flags iCloud Drive paths, which is what makes cross-machine detection work', () => {
    const iCloud = path.join(
      os.homedir(),
      'Library',
      'Mobile Documents',
      'com~apple~CloudDocs',
      'distill',
    );
    expect(inspectOutputDir(iCloud).inICloudDrive).toBe(true);
    expect(inspectOutputDir('/tmp/distill').inICloudDrive).toBe(false);
  });
});
