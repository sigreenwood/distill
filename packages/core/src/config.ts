import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CredentialStore } from './credentialStore.js';
import type { PlaudConfig as PlaudConfigData, PlaudCredentials, PlaudTokenData } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.plaud');
const CONFIG_FILE = 'config.json';

/**
 * File-backed credential store. Reads and writes the whole config object
 * (credentials, token) to ~/.plaud/config.json. This is what the CLI's
 * `plaud login` populates and what every pre-existing install has on disk.
 */
export class FileCredentialStore implements CredentialStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  private load(): PlaudConfigData {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8');
      return JSON.parse(raw) as PlaudConfigData;
    } catch {
      return {};
    }
  }

  private save(data: PlaudConfigData): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.load();
    const merged = { ...existing, ...data };
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

  getCredentials(): PlaudCredentials | undefined {
    return this.load().credentials;
  }

  saveCredentials(credentials: PlaudCredentials): void {
    this.save({ credentials });
  }

  clearCredentials(): void {
    const data = this.load();
    delete data.credentials;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  getToken(): PlaudTokenData | undefined {
    return this.load().token;
  }

  saveToken(token: PlaudTokenData): void {
    this.save({ token });
  }

  clearToken(): void {
    const data = this.load();
    delete data.token;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

/**
 * PlaudConfig is the public API the CLI and other callers use. It now
 * delegates to a CredentialStore so callers can swap in alternative
 * storage (e.g. macOS Keychain) without touching the auth/client code.
 *
 * The default constructor preserves the original behaviour: file-backed
 * storage at ~/.plaud/config.json. Existing CLI usage keeps working with
 * no changes.
 */
export class PlaudConfig {
  private store: CredentialStore;

  /**
   * @param storeOrDir Either a CredentialStore instance, or a string path
   *   to override the default ~/.plaud directory. Omitting the argument
   *   uses a FileCredentialStore at the default location.
   */
  constructor(storeOrDir?: CredentialStore | string) {
    if (storeOrDir === undefined) {
      this.store = new FileCredentialStore();
    } else if (typeof storeOrDir === 'string') {
      this.store = new FileCredentialStore(storeOrDir);
    } else {
      this.store = storeOrDir;
    }
  }

  load(): PlaudConfigData {
    const credentials = this.store.getCredentials();
    const token = this.store.getToken();
    const out: PlaudConfigData = {};
    if (credentials) out.credentials = credentials;
    if (token) out.token = token;
    return out;
  }

  saveToken(token: PlaudTokenData): void {
    this.store.saveToken(token);
  }

  saveCredentials(credentials: PlaudCredentials): void {
    this.store.saveCredentials(credentials);
  }

  /**
   * Atomic-ish save of arbitrary subset of config (credentials, token).
   * Retained from the original API so callers (the CLI tests in particular)
   * keep working unchanged. New callers should prefer the typed
   * saveCredentials / saveToken methods.
   */
  save(data: { credentials?: PlaudCredentials; token?: PlaudTokenData }): void {
    if (data.credentials) this.store.saveCredentials(data.credentials);
    if (data.token) this.store.saveToken(data.token);
  }

  getToken(): PlaudTokenData | undefined {
    return this.store.getToken();
  }

  getCredentials(): PlaudCredentials | undefined {
    return this.store.getCredentials();
  }

  clearCredentials(): void {
    this.store.clearCredentials();
  }

  clearToken(): void {
    this.store.clearToken();
  }
}
