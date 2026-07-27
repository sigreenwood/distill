import { describe, it, expect } from 'vitest';
import { PlaudConfig, PlaudAuth, PlaudClient } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Gate on usable auth material, not mere file existence — the Electron
// app creates ~/.plaud/config.json even before a successful sign-in
// (and keeps the password in Keychain, which the file store can't see).
const HAS_CREDS = (() => {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.plaud', 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.credentials?.password || parsed?.token?.accessToken);
  } catch {
    return false;
  }
})();

describe.skipIf(!HAS_CREDS)('integration (live API)', () => {
  const config = new PlaudConfig();
  const creds = config.getCredentials()!;
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  it('gets user info', async () => {
    const user = await client.getUserInfo();
    expect(user.id).toBeTruthy();
    expect(user.nickname).toBeTruthy();
  });

  it('lists recordings', async () => {
    const recs = await client.listRecordings();
    expect(Array.isArray(recs)).toBe(true);
  });

  it('gets recording detail', async () => {
    const recs = await client.listRecordings();
    if (recs.length === 0) return;
    const detail = await client.getRecording(recs[0].id);
    expect(detail.id).toBe(recs[0].id);
  });
});
