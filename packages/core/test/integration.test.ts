import { describe, it, expect } from 'vitest';
import { PlaudConfig, PlaudAuth, PlaudClient } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * The live-API integration tests run against api.plaud.ai using the
 * developer's real credentials. They skip cleanly when no usable
 * credentials are present, so CI and other contributors don't get
 * spurious failures.
 *
 * "Usable" here means: a config file at ~/.plaud/config.json AND a
 * non-empty password in either the file or the system Keychain. After
 * the in-app Sources sign-in landed, signed-out installs leave
 * `password: ""` in the file with no Keychain entry, which the file-
 * backed PlaudConfig used here reads as empty. Without this guard,
 * those installs run the tests and fail with "No credentials
 * configured" instead of skipping.
 *
 * Note: this scaffold uses the file-backed PlaudConfig only — it does
 * NOT consult Keychain. That's deliberate; live integration tests
 * against the real API need credentials anyway, and using only the
 * file path keeps the skip-condition deterministic across
 * environments.
 */
function hasUsableCredentials(): boolean {
  const cfgPath = path.join(os.homedir(), '.plaud', 'config.json');
  if (!fs.existsSync(cfgPath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      credentials?: { password?: string };
    };
    return typeof raw.credentials?.password === 'string'
      && raw.credentials.password.length > 0;
  } catch {
    return false;
  }
}

const HAS_CREDS = hasUsableCredentials();

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
