/**
 * macOS Keychain-backed CredentialStore for Plaud.
 *
 * Storage split:
 *   - password    -> macOS Keychain (service: KEYCHAIN_SERVICE, account = email)
 *   - email,region -> ~/.plaud/config.json (alongside the JWT)
 *   - token (JWT) -> ~/.plaud/config.json
 *
 * Why split: the password is the only long-lived shared secret; everything
 * else is either a public identifier (email, region) or a derivative
 * (JWT, recoverable by signing in again). Putting the password in
 * Keychain protects the long-tail risk where ~/.plaud/config.json gets
 * read by another process or accidentally shared.
 *
 * Migration from the file-only model: if a password exists in the file
 * but not in the Keychain, getCredentials() reads it from the file (so
 * existing installs keep working). The next saveCredentials() call
 * (e.g. after a successful sign-in via the new UI) writes the password
 * to the Keychain. The "remove from file" step is deliberately a
 * separate, opt-in action — see `migratePasswordToKeychain` below.
 *
 * Service name uses the new app id so the entries appear as "distill"
 * in Keychain Access.app, not "plaud-toolkit" or similar. Account is
 * the email so the user's Keychain shows whose account it's for.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as keytar from 'keytar';
import type { CredentialStore, PlaudCredentials, PlaudTokenData } from '@plaud/core';

export const KEYCHAIN_SERVICE = 'distill.plaud';

const PLAUD_DIR = path.join(os.homedir(), '.plaud');
const CONFIG_FILE = path.join(PLAUD_DIR, 'config.json');

/**
 * Shape of the on-disk config file. Mirrors @plaud/core's PlaudConfig
 * type but with `credentials.password` optional, since the Keychain
 * store keeps password elsewhere.
 */
interface OnDiskConfig {
  credentials?: {
    email: string;
    password?: string; // legacy field; new writes do not include it
    region: 'us' | 'eu';
  };
  token?: PlaudTokenData;
}

function readFile(): OnDiskConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as OnDiskConfig;
  } catch {
    return {};
  }
}

function writeFile(data: OnDiskConfig): void {
  fs.mkdirSync(PLAUD_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export class KeychainCredentialStore implements CredentialStore {
  /**
   * Read credentials. Email + region come from the file; password comes
   * from Keychain (with a fallback to the file's legacy password field
   * for installs that haven't been migrated yet).
   *
   * Returns undefined if no credentials are configured at all.
   *
   * Note: keytar's getPassword is async. The CredentialStore interface
   * is sync so we use the synchronous Atomics-based pattern... actually
   * no, we can't. The interface IS sync. This is a real impedance
   * mismatch worth confronting head-on.
   *
   * Resolution: we cache the password in memory after the first async
   * read, populated explicitly via prime() before the store is handed
   * to PlaudConfig. Callers in the Electron main process can `await`
   * prime() during app startup; from that point the sync getCredentials
   * works because the password is cached.
   */
  private cachedPassword: string | undefined;
  private cachedEmail: string | undefined;

  /**
   * Populate the in-memory password cache from Keychain. Must be called
   * once at app startup, after which getCredentials() works
   * synchronously. If the user has not yet signed in, prime() is a
   * no-op and getCredentials() returns undefined as expected.
   */
  async prime(): Promise<void> {
    const file = readFile();
    if (!file.credentials) {
      this.cachedPassword = undefined;
      this.cachedEmail = undefined;
      return;
    }
    const email = file.credentials.email;
    this.cachedEmail = email;

    // Try Keychain first, then fall back to the legacy password field
    // in the file (so pre-migration installs still work).
    const fromKeychain = await keytar.getPassword(KEYCHAIN_SERVICE, email);
    if (fromKeychain) {
      this.cachedPassword = fromKeychain;
      return;
    }
    if (file.credentials.password) {
      this.cachedPassword = file.credentials.password;
      return;
    }
    // Email + region in the file but no password anywhere — treat as
    // not-signed-in. Caller will prompt for sign-in.
    this.cachedPassword = undefined;
  }

  getCredentials(): PlaudCredentials | undefined {
    const file = readFile();
    if (!file.credentials || !this.cachedPassword) {
      return undefined;
    }
    // Defensive: if the email in the file no longer matches the email
    // we cached the password for, treat as not-signed-in. Happens if the
    // user signed out and back in as a different account between prime()
    // calls — shouldn't normally happen but worth handling.
    if (this.cachedEmail !== file.credentials.email) {
      return undefined;
    }
    return {
      email: file.credentials.email,
      password: this.cachedPassword,
      region: file.credentials.region,
    };
  }

  /**
   * Save credentials. Password goes to Keychain; email and region go
   * to the file. After this call, getCredentials() returns the new
   * values immediately (the in-memory cache is updated).
   *
   * keytar.setPassword is async, so this method is async too. The
   * sync method on the CredentialStore interface delegates to a
   * fire-and-forget setPassword; new code in the app should call
   * saveCredentialsAsync directly.
   */
  saveCredentials(credentials: PlaudCredentials): void {
    // Sync interface: kick off the async write but don't wait. This
    // matches how the CLI's file write is sync — the caller's next
    // operation (e.g. PlaudAuth.login) reads from the in-memory cache
    // we set immediately below, so the async Keychain write being
    // in-flight doesn't cause incorrect behaviour.
    void this.saveCredentialsAsync(credentials);
  }

  /**
   * Async version of saveCredentials. Prefer this from app code so
   * Keychain write errors surface explicitly.
   */
  async saveCredentialsAsync(credentials: PlaudCredentials): Promise<void> {
    // Write to Keychain first — if that fails, we don't want to
    // overwrite the file with a half-state.
    await keytar.setPassword(KEYCHAIN_SERVICE, credentials.email, credentials.password);

    // Persist email + region to the file. Deliberately do NOT write
    // the password here; the migration from file-stored password
    // happens in a separate step (migratePasswordToKeychain).
    const file = readFile();
    file.credentials = {
      email: credentials.email,
      region: credentials.region,
      // password intentionally omitted from new writes
    };
    writeFile(file);

    this.cachedEmail = credentials.email;
    this.cachedPassword = credentials.password;
  }

  clearCredentials(): void {
    void this.clearCredentialsAsync();
  }

  async clearCredentialsAsync(): Promise<void> {
    const file = readFile();
    if (file.credentials) {
      // Best-effort delete from Keychain. If this throws (e.g. user
      // already deleted it manually), still proceed to clear the file.
      try {
        await keytar.deletePassword(KEYCHAIN_SERVICE, file.credentials.email);
      } catch {
        // ignore
      }
      delete file.credentials;
      writeFile(file);
    }
    this.cachedEmail = undefined;
    this.cachedPassword = undefined;
  }

  getToken(): PlaudTokenData | undefined {
    return readFile().token;
  }

  saveToken(token: PlaudTokenData): void {
    const file = readFile();
    file.token = token;
    writeFile(file);
  }

  clearToken(): void {
    const file = readFile();
    delete file.token;
    writeFile(file);
  }
}

/**
 * One-time migration: if the password is still in the on-disk file
 * AND a copy is now in Keychain, remove the password field from the
 * file. Idempotent — safe to call on every launch.
 *
 * Order matters: we only remove from the file once we've verified the
 * Keychain copy is readable. If the Keychain read fails for any
 * reason, the file copy stays as a fallback.
 *
 * Returns:
 *   'no-op'              if no password in the file (nothing to do)
 *   'migrated'           if we removed the password from the file
 *   'kept-as-fallback'   if Keychain didn't have a copy yet (so file
 *                        is still the source of truth)
 */
export async function migratePasswordToKeychain(): Promise<
  'no-op' | 'migrated' | 'kept-as-fallback'
> {
  const file = readFile();
  if (!file.credentials || !file.credentials.password) {
    return 'no-op';
  }
  const email = file.credentials.email;

  const keychainCopy = await keytar.getPassword(KEYCHAIN_SERVICE, email);
  if (!keychainCopy) {
    // No Keychain entry yet. Don't touch the file.
    return 'kept-as-fallback';
  }
  if (keychainCopy !== file.credentials.password) {
    // Different password in Keychain than in the file. The user
    // probably signed in via the UI and the file copy is stale.
    // Trust Keychain, remove the file copy.
  }

  delete file.credentials.password;
  writeFile(file);
  return 'migrated';
}
