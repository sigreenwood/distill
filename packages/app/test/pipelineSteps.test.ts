import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { audioFileExists } from '../src/main/pipelineSteps.js';

// The rest of pipelineSteps.ts (doDownload/doTranscribe/etc.) drives real
// subprocesses and network calls, so it isn't covered here — audioFileExists
// is the one pure, filesystem-only piece, and the only part of state.ts's
// `State` class methods this feature touches that doesn't need a real
// better-sqlite3 database (see CLAUDE.md's note on the Electron ABI trap).
describe('audioFileExists', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-audio-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('is false when audio_path is null', () => {
    expect(audioFileExists({ audio_path: null })).toBe(false);
  });

  it('is false when audio_path points at nothing on disk', () => {
    expect(audioFileExists({ audio_path: path.join(tmp, 'missing.mp3') })).toBe(false);
  });

  it('is true when the file is actually there', () => {
    const p = path.join(tmp, 'recording.mp3');
    fs.writeFileSync(p, 'not really audio');
    expect(audioFileExists({ audio_path: p })).toBe(true);
  });
});
