import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRecorder, RecorderError } from '../src/main/recorder.js';

const hasFfmpeg = spawnSync('which', ['ffmpeg']).status === 0;

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** Stands in for distill-capture: writes real wavs, speaks the same event protocol. */
function fakeHelper(dir: string, body: string): string {
  const p = path.join(dir, 'fake-capture.sh');
  fs.writeFileSync(p, `#!/bin/bash\nSYS="$1"; MIC="$2"\n${body}\n`, { mode: 0o755 });
  return p;
}

const WRITE_TRACKS =
  `ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -ac 1 "$SYS"\n` +
  `ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=220:duration=2" -ar 16000 -ac 1 "$MIC"\n`;

describe.skipIf(!hasFfmpeg)('recorder lifecycle', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const make = (helper: string, imported: { mp3: string; tracks: unknown; existed: boolean[] }[], warnings: string[] = []) =>
    createRecorder({
      logger: silentLogger,
      helperPath: helper,
      scratchRoot: path.join(tmp, 'scratch'),
      importFile: async (mp3, tracks) => {
        imported.push({
          mp3,
          tracks,
          existed: [fs.existsSync(mp3), ...(tracks ? [fs.existsSync(tracks.mic), fs.existsSync(tracks.others)] : [])],
        });
      },
      onWarning: (m) => warnings.push(m),
      onChange: () => {},
    });

  it('records, mixes, keeps both tracks, imports, and cleans up scratch', async () => {
    const helper = fakeHelper(
      tmp,
      WRITE_TRACKS + `echo '{"event":"ready","mic":true}'\ntrap 'echo "{\\"event\\":\\"stopped\\"}"; exit 0' INT\nwhile true; do sleep 0.1; done`,
    );
    const imported: { mp3: string; tracks: unknown; existed: boolean[] }[] = [];
    const rec = make(helper, imported);
    await rec.start();
    expect(rec.startedAt()).not.toBeNull();
    await expect(rec.start()).rejects.toBeInstanceOf(RecorderError);
    await rec.stop();

    expect(rec.startedAt()).toBeNull();
    expect(imported).toHaveLength(1);
    expect(path.basename(imported[0].mp3)).toMatch(/^Call \d{4}-\d{2}-\d{2} \d{2}-\d{2}\.mp3$/);
    expect(imported[0].tracks).not.toBeNull();
    expect(imported[0].existed).toEqual([true, true, true]); // all present at import time
    expect(fs.existsSync(path.join(tmp, 'scratch', fs.readdirSync(path.join(tmp, 'scratch'))[0] ?? 'none'))).toBe(false);
  }, 30_000);

  it('reports a helper that fails to start, and leaves nothing behind', async () => {
    const helper = fakeHelper(tmp, `echo '{"event":"error","message":"Could not create the system audio tap (OSStatus 1)."}'\nexit 1`);
    const rec = make(helper, []);
    await expect(rec.start()).rejects.toThrow(/system audio tap/);
    expect(rec.startedAt()).toBeNull();
    expect(fs.readdirSync(path.join(tmp, 'scratch'))).toEqual([]);
  }, 30_000);

  it('salvages and imports when the helper dies mid-recording', async () => {
    const helper = fakeHelper(tmp, WRITE_TRACKS + `echo '{"event":"ready","mic":true}'\nsleep 0.5\nexit 3`);
    const imported: { mp3: string; tracks: unknown; existed: boolean[] }[] = [];
    const warnings: string[] = [];
    const rec = make(helper, imported, warnings);
    await rec.start();
    await new Promise((r) => setTimeout(r, 4000));
    expect(rec.startedAt()).toBeNull();
    expect(warnings.join(' ')).toMatch(/stopped unexpectedly/);
    expect(imported).toHaveLength(1);
  }, 30_000);

  it('keeps the raw tracks when import fails', async () => {
    const helper = fakeHelper(
      tmp,
      WRITE_TRACKS + `echo '{"event":"ready","mic":true}'\ntrap 'exit 0' INT\nwhile true; do sleep 0.1; done`,
    );
    const rec = createRecorder({
      logger: silentLogger,
      helperPath: helper,
      scratchRoot: path.join(tmp, 'scratch'),
      importFile: async () => {
        throw new Error('disk full');
      },
      onWarning: () => {},
      onChange: () => {},
    });
    await rec.start();
    await expect(rec.stop()).rejects.toThrow(/raw audio is kept in/);
    const kept = path.join(tmp, 'scratch', fs.readdirSync(path.join(tmp, 'scratch'))[0]);
    expect(fs.existsSync(path.join(kept, 'system.wav'))).toBe(true);
  }, 30_000);
});
