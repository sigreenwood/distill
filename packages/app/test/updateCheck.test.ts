import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseVersion,
  isNewer,
  pickUpdate,
  parseSha256File,
  checkForUpdate,
  downloadUpdate,
  shouldNotify,
  loadMemory,
  saveMemory,
  UpdateError,
  type UpdateInfo,
} from '../src/main/updateCheck.js';

const BASE = 'https://github.com/sigreenwood/distill/releases/download';
const HASH = 'a'.repeat(64);

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.0.22',
  draft: false,
  prerelease: false,
  body: 'Notes',
  html_url: 'https://github.com/sigreenwood/distill/releases/tag/v0.0.22',
  assets: [
    { name: 'distill-0.0.22-arm64.pkg', size: 5, browser_download_url: `${BASE}/v0.0.22/distill-0.0.22-arm64.pkg`, digest: `sha256:${HASH}` },
  ],
  ...over,
});

describe('versions', () => {
  it('parses plain x.y.z with or without a v', () => {
    expect(parseVersion('v0.0.21')).toEqual([0, 0, 21]);
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('1.0')).toBeNull();
    expect(parseVersion('1.0.0-beta.1')).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(isNewer('0.0.22', '0.0.21')).toBe(true);
    expect(isNewer('0.0.100', '0.0.99')).toBe(true);
    expect(isNewer('0.1.0', '0.0.99')).toBe(true);
    expect(isNewer('0.0.21', '0.0.21')).toBe(false);
    expect(isNewer('0.0.20', '0.0.21')).toBe(false);
    expect(isNewer('garbage', '0.0.21')).toBe(false);
  });
});

describe('pickUpdate', () => {
  it('offers a newer release with its package and digest', () => {
    const u = pickUpdate(release(), '0.0.21');
    expect(u).toMatchObject({ version: '0.0.22', assetName: 'distill-0.0.22-arm64.pkg', sha256: HASH, size: 5 });
  });

  it('offers nothing when current, older, draft or prerelease', () => {
    expect(pickUpdate(release(), '0.0.22')).toBeNull();
    expect(pickUpdate(release(), '0.0.30')).toBeNull();
    expect(pickUpdate(release({ draft: true }), '0.0.21')).toBeNull();
    expect(pickUpdate(release({ prerelease: true }), '0.0.21')).toBeNull();
  });

  it('ignores a package that is not on this repo\'s releases', () => {
    const evil = release({
      assets: [{ name: 'distill-0.0.22-arm64.pkg', size: 5, browser_download_url: 'https://evil.example/distill-0.0.22-arm64.pkg', digest: `sha256:${HASH}` }],
    });
    expect(pickUpdate(evil, '0.0.21')).toBeNull();
  });

  it('ignores assets that are not the arm64 installer', () => {
    const other = release({ assets: [{ name: 'distill-0.0.22-x64.pkg', browser_download_url: `${BASE}/v0.0.22/x`, size: 1 }] });
    expect(pickUpdate(other, '0.0.21')).toBeNull();
  });

  it('falls back to a .sha256 sidecar when the API gives no digest', () => {
    const r = release({
      assets: [
        { name: 'distill-0.0.22-arm64.pkg', size: 5, browser_download_url: `${BASE}/v0.0.22/distill-0.0.22-arm64.pkg` },
        { name: 'distill-0.0.22-arm64.pkg.sha256', browser_download_url: `${BASE}/v0.0.22/distill-0.0.22-arm64.pkg.sha256` },
      ],
    });
    const u = pickUpdate(r, '0.0.21')!;
    expect(u.sha256).toBeNull();
    expect(u.sha256Url).toMatch(/\.sha256$/);
  });

  it('survives junk', () => {
    expect(pickUpdate(null, '0.0.21')).toBeNull();
    expect(pickUpdate('x', '0.0.21')).toBeNull();
    expect(pickUpdate({ tag_name: 5 }, '0.0.21')).toBeNull();
  });
});

describe('parseSha256File', () => {
  it('reads shasum output', () => {
    expect(parseSha256File(`${HASH.toUpperCase()}  distill-0.0.22-arm64.pkg\n`)).toBe(HASH);
    expect(parseSha256File('nothing here')).toBeNull();
  });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('checkForUpdate', () => {
  it('returns the update, and fetches the sidecar checksum when needed', async () => {
    const r = release({
      assets: [
        { name: 'distill-0.0.22-arm64.pkg', size: 5, browser_download_url: `${BASE}/v0.0.22/distill-0.0.22-arm64.pkg` },
        { name: 'distill-0.0.22-arm64.pkg.sha256', browser_download_url: `${BASE}/v0.0.22/distill-0.0.22-arm64.pkg.sha256` },
      ],
    });
    const seen: string[] = [];
    const f = (async (url: string) => {
      seen.push(String(url));
      return String(url).endsWith('.sha256') ? new Response(`${HASH}  x\n`) : json(r);
    }) as unknown as typeof fetch;
    const u = await checkForUpdate('0.0.21', f);
    expect(u?.sha256).toBe(HASH);
    expect(seen).toHaveLength(2);
  });

  it('treats 404 (no releases yet) as up to date', async () => {
    expect(await checkForUpdate('0.0.21', (async () => json({}, 404)) as unknown as typeof fetch)).toBeNull();
  });

  it('turns rate limiting, server errors and network failure into readable errors', async () => {
    await expect(checkForUpdate('0.0.21', (async () => json({}, 403)) as unknown as typeof fetch)).rejects.toThrow(/rate-limiting/);
    await expect(checkForUpdate('0.0.21', (async () => json({}, 500)) as unknown as typeof fetch)).rejects.toBeInstanceOf(UpdateError);
    await expect(
      checkForUpdate('0.0.21', (async () => { throw new Error('offline'); }) as unknown as typeof fetch),
    ).rejects.toThrow(/offline/);
  });
});

describe('downloadUpdate', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const body = Buffer.from('hello');
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
    version: '0.0.22', notes: '', pageUrl: '', assetName: 'distill-0.0.22-arm64.pkg', assetUrl: `${BASE}/v0.0.22/x`,
    size: body.length, sha256: sha, sha256Url: null, ...over,
  });
  const ok = (async () => new Response(body)) as unknown as typeof fetch;

  it('saves a verified download under its final name and reports progress', async () => {
    const progress: number[] = [];
    const p = await downloadUpdate(info(), tmp, '0.0.21', (f) => progress.push(f), ok);
    expect(fs.readFileSync(p).toString()).toBe('hello');
    expect(path.basename(p)).toBe('distill-0.0.22-arm64.pkg');
    expect(progress.at(-1)).toBe(1);
    expect(fs.readdirSync(tmp)).toEqual(['distill-0.0.22-arm64.pkg']);
  });

  it('discards a download whose checksum does not match', async () => {
    await expect(downloadUpdate(info({ sha256: 'b'.repeat(64) }), tmp, '0.0.21', undefined, ok)).rejects.toThrow(/did not match/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('discards a truncated download', async () => {
    await expect(downloadUpdate(info({ size: 999 }), tmp, '0.0.21', undefined, ok)).rejects.toThrow(/incomplete/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it('refuses to install a release that published no checksum', async () => {
    await expect(downloadUpdate(info({ sha256: null }), tmp, '0.0.21', undefined, ok)).rejects.toThrow(/no published checksum/);
  });

  it('reports HTTP failure', async () => {
    const bad = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadUpdate(info(), tmp, '0.0.21', undefined, bad)).rejects.toThrow(/404/);
  });
});

describe('update memory', () => {
  it('tells the user once per version, and never about a skipped one', () => {
    expect(shouldNotify({ notified: null, skipped: null }, '0.0.22')).toBe(true);
    expect(shouldNotify({ notified: '0.0.22', skipped: null }, '0.0.22')).toBe(false);
    expect(shouldNotify({ notified: '0.0.22', skipped: null }, '0.0.23')).toBe(true);
    expect(shouldNotify({ notified: null, skipped: '0.0.22' }, '0.0.22')).toBe(false);
    expect(shouldNotify({ notified: null, skipped: '0.0.22' }, '0.0.23')).toBe(true);
  });

  it('round-trips through a file and tolerates a missing or corrupt one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    const f = path.join(dir, 'sub', 'state.json');
    expect(loadMemory(f)).toEqual({ notified: null, skipped: null });
    saveMemory(f, { notified: '0.0.22', skipped: null });
    expect(loadMemory(f)).toEqual({ notified: '0.0.22', skipped: null });
    fs.writeFileSync(f, '{nope');
    expect(loadMemory(f)).toEqual({ notified: null, skipped: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
