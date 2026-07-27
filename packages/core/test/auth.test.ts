import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudAuth', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-'));
    config = new PlaudConfig(tmpDir);
    config.saveCredentials({ email: 'test@plaud.ai', password: 'pass123', region: 'eu' });
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs in with email+password and stores token', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);

    const stored = config.getToken();
    expect(stored?.accessToken).toBe(fakeToken);
  });

  it('returns cached token when still valid', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: fakeToken,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes token when expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 1000;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: pastExp, iat: pastExp - 86400 })).toString('base64url');
    const expiredToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: expiredToken,
      tokenType: 'Bearer',
      issuedAt: (pastExp - 86400) * 1000,
      expiresAt: pastExp * 1000,
    });

    const newExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const newPayload = Buffer.from(JSON.stringify({ sub: 'abc', exp: newExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const newToken = `eyJhbGciOiJIUzI1NiJ9.${newPayload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      ok: true,
      json: async () => ({ status: 0, access_token: newToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(newToken);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws when no credentials stored', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-empty-'));
    const emptyConfig = new PlaudConfig(emptyDir);
    const emptyAuth = new PlaudAuth(emptyConfig);

    await expect(emptyAuth.getToken()).rejects.toThrow('No credentials');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws on wrong credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password', access_token: '' }),
    });

    await expect(auth.getToken()).rejects.toThrow('wrong account or password');
  });
});

describe('PlaudAuth token refresh buffer', () => {
  const DAY = 24 * 60 * 60 * 1000;

  function makeAuth(tmpDir: string, lifetimeDays: number, ageDays: number) {
    const config = new PlaudConfig(tmpDir);
    const issuedAt = Date.now() - ageDays * DAY;
    config.saveCredentials({ email: 't@t.com', password: 'p', region: 'eu' });
    config.saveToken({
      accessToken: 'cached-token',
      tokenType: 'Bearer',
      issuedAt,
      expiresAt: issuedAt + lifetimeDays * DAY,
    });
    return new PlaudAuth(config);
  }

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-buffer-'));
    mockFetch.mockReset();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('reuses a freshly issued 30-day token instead of re-logging in', async () => {
    // Regression: a flat 30-day buffer made every 30-day token look stale
    // the moment it was minted, forcing a full login on every call.
    const auth = makeAuth(tmpDir, 30, 0);
    const token = await auth.getToken();
    expect(token).toBe('cached-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes a 30-day token in its final tenth', async () => {
    const auth = makeAuth(tmpDir, 30, 28);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        access_token: `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(
          JSON.stringify({
            exp: Math.floor(Date.now() / 1000) + 30 * 86400,
            iat: Math.floor(Date.now() / 1000),
          }),
        ).toString('base64url')}.sig`,
        token_type: 'Bearer',
      }),
    });
    await auth.getToken();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('still reuses a long-lived token well before expiry', async () => {
    const auth = makeAuth(tmpDir, 300, 100);
    expect(await auth.getToken()).toBe('cached-token');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
