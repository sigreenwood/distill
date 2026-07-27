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

  it('sends a non-default User-Agent header (Plaud blocks the "node" UA)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, data_file_list: [] }),
    });

    await client.listRecordings();

    const [, init] = mockFetch.mock.calls[0];
    const ua = new Headers(init.headers).get('User-Agent');
    expect(ua).toBeTruthy();
    expect(ua).not.toBe('node');
  });

  it('uses an injected requester instead of global fetch (Obsidian requestUrl path)', async () => {
    const calls: string[] = [];
    const requester = vi.fn(async (req: { url: string }) => {
      calls.push(req.url);
      return { status: 200, ok: true, json: async () => ({ status: 0, data_file_list: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
    });
    const config = new PlaudConfig(tmpDir);
    const auth = new PlaudAuth(config, requester);
    const injected = new PlaudClient(auth, 'eu', requester);

    await injected.listRecordings();

    expect(requester).toHaveBeenCalled();
    expect(calls[0]).toContain('/file/simple/web');
    expect(mockFetch).not.toHaveBeenCalled(); // global fetch must NOT be used
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
});
