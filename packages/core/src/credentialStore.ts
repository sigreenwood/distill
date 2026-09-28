/**
 * Abstraction over how Plaud credentials and the cached JWT are stored.
 *
 * The CLI uses a file-backed implementation (FileCredentialStore) that writes
 * everything to ~/.plaud/config.json — that's the default and what every
 * existing install already has on disk.
 *
 * Other consumers (like the distill Electron app) can supply alternative
 * implementations — for example, one that puts the password in macOS Keychain
 * rather than a plaintext file. The interface lets PlaudAuth and PlaudClient
 * stay unchanged across both.
 *
 * The interface is deliberately small: get/save credentials (email+password+
 * region as a unit), get/save token (the JWT). Everything else is built on
 * top of these.
 */

import type { PlaudCredentials, PlaudTokenData } from './types.js';

export interface CredentialStore {
  getCredentials(): PlaudCredentials | undefined;
  saveCredentials(credentials: PlaudCredentials): void;
  clearCredentials(): void;

  getToken(): PlaudTokenData | undefined;
  saveToken(token: PlaudTokenData): void;
  clearToken(): void;
}
