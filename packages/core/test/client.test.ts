import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudClient } from '../src/client.js';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudClient', () => {
  let tmpDir: string;
  let client: PlaudClient;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-client-'));
    const config = new PlaudConfig(tmpDir);
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
    config.saveCredentials({ email: 't@t.com', password: 'p', region: 'eu' });
    config.saveToken({
      accessToken: token,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });
    const auth = new PlaudAuth(config);
    client = new PlaudClient(auth, 'eu');
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists recordings', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [
          { id: 'rec1', filename: 'Test', is_trash: false },
          { id: 'rec2', filename: 'Trash', is_trash: true },
        ],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(recs[0].id).toBe('rec1');
    expect(mockFetch.mock.calls[0][0]).toContain(
      '/file/simple/web?skip=0&limit=99999&is_trash=2&sort_by=start_time&is_desc=true',
    );
  });

  it('gets recording detail with transcript', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data: {
          file_id: 'rec1',
          file_name: 'Meeting',
          pre_download_content_list: [
            { data_content: 'Short' },
            { data_content: 'This is the full transcript of the meeting.' },
          ],
        },
      }),
    });

    const detail = await client.getRecording('rec1');
    expect(detail.transcript).toBe('This is the full transcript of the meeting.');
  });

  it('gets user info', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_user: { id: 'u1', nickname: 'Sergi', email: 'test@plaud.ai', country: 'ES', membership_type: 'starter' },
      }),
    });

    const user = await client.getUserInfo();
    expect(user.nickname).toBe('Sergi');
  });

  it('handles region mismatch', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'api-euc1.plaud.ai' } },
      }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 0,
        data_file_list: [{ id: 'rec1', filename: 'Test', is_trash: false }],
      }),
    });

    const recs = await client.listRecordings();
    expect(recs).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('getMp3Url', () => {
    it('returns null when the recording is gone (HTTP 404)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const url = await client.getMp3Url('rec1');
      expect(url).toBeNull();
    });

    it('throws when auth fails so the caller can show "sign in again"', async () => {
      // Simulate signed-out state: clear credentials, drop the token,
      // and let auth.login() throw "No credentials configured" when
      // getMp3Url tries to acquire a fresh token.
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-noauth-'));
      const cfg = new PlaudConfig(tmp);
      const noAuthClient = new PlaudClient(new PlaudAuth(cfg), 'eu');
      try {
        await expect(noAuthClient.getMp3Url('rec1')).rejects.toThrow(
          /No credentials configured/,
        );
        // No fetch should have happened — we didn't have a token to even
        // try with. This guards against regressions where the catch-all
        // {} swallows the auth error and turns it into a null return.
        expect(mockFetch).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    it('propagates non-404 HTTP errors rather than swallowing them', async () => {
      // E.g. 500 from Plaud during temp-url generation. Returning null
      // here previously made every server-side blip look identical to
      // "recording deleted", losing actionable detail.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(client.getMp3Url('rec1')).rejects.toThrow(
        /Plaud API error: 500/,
      );
    });
  });
});
