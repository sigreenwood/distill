import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Update checks against this project's GitHub Releases.
 *
 * Suggestion-only, like model and prompt updates: this finds a newer release
 * and downloads it when the user says so; it never installs anything itself.
 * The installer is the stock macOS Installer opening the .pkg — Squirrel and
 * electron-updater both refuse to replace an unsigned app, and distill is
 * deliberately unsigned (see electron-builder.yml).
 *
 * The one network call is a GET of the latest-release JSON. It sends no
 * account, recording or machine data — only a User-Agent carrying the version.
 */
export const REPO = 'sigreenwood/distill';
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** Assets must come from this repo's releases; anything else is ignored. */
const ASSET_URL_PREFIX = `https://github.com/${REPO}/releases/download/`;
const PKG_NAME = /^distill-\d+\.\d+\.\d+-arm64\.pkg$/;

export interface UpdateInfo {
  version: string;
  notes: string;
  pageUrl: string;
  assetName: string;
  assetUrl: string;
  size: number;
  /** Lower-case hex SHA-256, or null if the release did not publish one. */
  sha256: string | null;
  /** Where a `<asset>.sha256` file lives, when the digest was not in the API response. */
  sha256Url: string | null;
}

export class UpdateError extends Error {
  userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = 'UpdateError';
  }
}

/** "v0.0.21" / "0.0.21" -> [0,0,21]. Anything else (1.0, 1.0.0-beta) is not a release we offer. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * Turn GitHub's release JSON into an offer, or null when there is nothing to
 * offer (no newer version, a draft/prerelease, no matching package). Pure.
 */
export function pickUpdate(release: unknown, currentVersion: string): UpdateInfo | null {
  const r = asRecord(release);
  if (!r || r.draft === true || r.prerelease === true) return null;
  const tag = typeof r.tag_name === 'string' ? r.tag_name : '';
  const version = parseVersion(tag) ? tag.replace(/^v/, '') : null;
  if (!version || !isNewer(version, currentVersion)) return null;

  const assets = Array.isArray(r.assets) ? r.assets.map(asRecord).filter((a) => a !== null) : [];
  const pkg = assets.find(
    (a) =>
      typeof a.name === 'string' &&
      PKG_NAME.test(a.name) &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(ASSET_URL_PREFIX),
  );
  if (!pkg) return null;

  const name = pkg.name as string;
  const digest = typeof pkg.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(pkg.digest) : null;
  const sidecar = assets.find(
    (a) =>
      a.name === `${name}.sha256` &&
      typeof a.browser_download_url === 'string' &&
      a.browser_download_url.startsWith(ASSET_URL_PREFIX),
  );
  return {
    version,
    notes: typeof r.body === 'string' ? r.body : '',
    pageUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${REPO}/releases`,
    assetName: name,
    assetUrl: pkg.browser_download_url as string,
    size: typeof pkg.size === 'number' ? pkg.size : 0,
    sha256: digest ? digest[1].toLowerCase() : null,
    sha256Url: sidecar ? (sidecar.browser_download_url as string) : null,
  };
}

/** First 64-hex token in a `shasum`-style file ("<hash>  <name>"), lower-cased. */
export function parseSha256File(text: string): string | null {
  const m = /\b([0-9a-f]{64})\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

type Fetch = typeof fetch;

function headers(currentVersion: string): Record<string, string> {
  return { 'User-Agent': `distill/${currentVersion}`, Accept: 'application/vnd.github+json' };
}

/** Null when up to date (or no releases yet). Throws UpdateError on a real failure. */
export async function checkForUpdate(
  currentVersion: string,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
): Promise<UpdateInfo | null> {
  let res: Response;
  try {
    res = await fetchImpl(LATEST_RELEASE_URL, { headers: headers(currentVersion), signal });
  } catch (e) {
    throw new UpdateError(`Could not reach GitHub to check for updates (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (res.status === 404) return null; // no releases published yet
  if (res.status === 403 || res.status === 429) {
    throw new UpdateError('GitHub is rate-limiting update checks from this network. Try again later.');
  }
  if (!res.ok) throw new UpdateError(`GitHub returned ${res.status} when checking for updates.`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new UpdateError('GitHub sent a response that was not understood.');
  }
  const info = pickUpdate(json, currentVersion);
  if (info && !info.sha256 && info.sha256Url) {
    try {
      const sres = await fetchImpl(info.sha256Url, { headers: headers(currentVersion), signal });
      if (sres.ok) info.sha256 = parseSha256File(await sres.text());
    } catch {
      // No checksum means no in-app install, not no notification; handled by the caller.
    }
  }
  return info;
}

/**
 * Download the package into `destDir`, checking size and SHA-256. The file only
 * gets its final name once it has verified; a bad download is deleted.
 */
export async function downloadUpdate(
  info: UpdateInfo,
  destDir: string,
  currentVersion: string,
  onProgress?: (fraction: number) => void,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
): Promise<string> {
  if (!info.sha256) throw new UpdateError('This release has no published checksum, so it will not be installed from inside the app.');
  fs.mkdirSync(destDir, { recursive: true });
  const finalPath = path.join(destDir, info.assetName);
  const partPath = `${finalPath}.part`;

  let res: Response;
  try {
    res = await fetchImpl(info.assetUrl, { headers: { 'User-Agent': `distill/${currentVersion}` }, signal });
  } catch (e) {
    throw new UpdateError(`Download failed (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!res.ok || !res.body) throw new UpdateError(`Download failed: GitHub returned ${res.status}.`);

  const total = info.size || Number(res.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const out = fs.createWriteStream(partPath);
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', r));
      if (total > 0) onProgress?.(Math.min(1, received / total));
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(partPath, { force: true });
    if (signal?.aborted) throw new UpdateError('Download cancelled.');
    throw new UpdateError(`Download failed part-way (${e instanceof Error ? e.message : String(e)}).`);
  }

  if (info.size > 0 && received !== info.size) {
    fs.rmSync(partPath, { force: true });
    throw new UpdateError(`Download was incomplete (${received} of ${info.size} bytes). Try again.`);
  }
  if (hash.digest('hex') !== info.sha256) {
    fs.rmSync(partPath, { force: true });
    throw new UpdateError('The downloaded file did not match its published checksum and was discarded.');
  }
  fs.renameSync(partPath, finalPath);
  return finalPath;
}

/** Remember which version we have already told the user about, so a check is not a nag. */
export interface UpdateMemory {
  notified: string | null;
  skipped: string | null;
}

export function shouldNotify(mem: UpdateMemory, version: string): boolean {
  return mem.skipped !== version && mem.notified !== version;
}

export function loadMemory(file: string): UpdateMemory {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdateMemory>;
    return { notified: o.notified ?? null, skipped: o.skipped ?? null };
  } catch {
    return { notified: null, skipped: null };
  }
}

export function saveMemory(file: string, mem: UpdateMemory): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(mem));
  } catch {
    // Worst case the user hears about the same version once more.
  }
}
