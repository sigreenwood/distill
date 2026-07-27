import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as keytar from 'keytar';
import type { CredentialStore, PlaudCredentials, PlaudTokenData } from '@plaud/core';

const KEYCHAIN_SERVICE = 'distill.plaud';
const PLAUD_DIR = path.join(os.homedir(), '.plaud');
const CONFIG_FILE = path.join(PLAUD_DIR, 'config.json');

/**
 * Shape of ~/.plaud/config.json as this store uses it. Unlike the core
 * PlaudCredentials, `password` is optional here — keychain-mode writes
 * deliberately omit it from the file (it lives in the Keychain), and it
 * only appears for legacy installs that haven't migrated yet.
 */
interface PlaudFileData {
  credentials?: Omit<PlaudCredentials, 'password'> & { password?: string };
  token?: PlaudTokenData;
}

function readFile(): PlaudFileData {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as PlaudFileData;
  } catch {
    return {};
  }
}

function writeFile(data: PlaudFileData): void {
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
   * Note: keytar's getPassword is async but the CredentialStore
   * interface is sync. This is a real impedance mismatch worth
   * confronting head-on.
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
    const fromKeychain = await keytar.getPassword(KEYCHAIN_SERVICE, email);
    if (fromKeychain) {
      this.cachedPassword = fromKeychain;
      return;
    }
    if (file.credentials.password) {
      this.cachedPassword = file.credentials.password;
      return;
    }
    this.cachedPassword = undefined;
  }

  getCredentials(): PlaudCredentials | undefined {
    const file = readFile();
    if (!file.credentials || !this.cachedPassword) {
      return undefined;
    }
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
    void this.saveCredentialsAsync(credentials);
  }

  /**
   * Async version of saveCredentials. Prefer this from app code so
   * Keychain write errors surface explicitly.
   */
  async saveCredentialsAsync(credentials: PlaudCredentials): Promise<void> {
    await keytar.setPassword(KEYCHAIN_SERVICE, credentials.email, credentials.password);
    const file = readFile();
    file.credentials = {
      email: credentials.email,
      region: credentials.region,
      // password intentionally omitted from new writes
    } as PlaudCredentials;
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
      try {
        await keytar.deletePassword(KEYCHAIN_SERVICE, file.credentials.email);
      } catch {
        // Keychain entry may not exist; the file cleanup below still runs
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

export type MigrationResult = 'no-op' | 'kept-as-fallback' | 'migrated';

/**
 * One-time migration: if ~/.plaud/config.json still carries a plaintext
 * password AND the Keychain already has a copy, drop the file copy. If
 * the Keychain has no copy yet, keep the file password as the fallback
 * (prime() reads it) — we never delete the only copy.
 */
export async function migratePasswordToKeychain(): Promise<MigrationResult> {
  const file = readFile();
  if (!file.credentials || !file.credentials.password) {
    return 'no-op';
  }
  const email = file.credentials.email;
  const keychainCopy = await keytar.getPassword(KEYCHAIN_SERVICE, email);
  if (!keychainCopy) {
    return 'kept-as-fallback';
  }
  delete (file.credentials as Partial<PlaudCredentials>).password;
  writeFile(file);
  return 'migrated';
}
