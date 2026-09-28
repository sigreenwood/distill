/**
 * Thin wrapper around @plaud/core that:
 *   1. Loads Plaud credentials from a CredentialStore (Keychain-backed
 *      in the app, file-backed in the CLI). Falls through to the legacy
 *      file-only path if neither exists.
 *   2. Constructs PlaudAuth + PlaudClient ready for use.
 *   3. Surfaces clear errors if no credentials or token are available.
 *
 * Sign-in itself happens via the Sources pane in Settings (calls
 * signInPlaud below). The CLI's `plaud login` command still works as
 * a fallback for headless setups but is no longer the primary path.
 */

import { PlaudAuth, PlaudClient, PlaudConfig } from '@plaud/core';
import type { CredentialStore, PlaudCredentials, PlaudRecording } from '@plaud/core';
import { KeychainCredentialStore } from './sources/keychainCredentialStore.js';

export class PlaudNotAuthenticatedError extends Error {
  constructor() {
    super(
      'Plaud is not authenticated. Open Settings -> Sources and sign in to Plaud.',
    );
    this.name = 'PlaudNotAuthenticatedError';
  }
}

export interface PlaudConnection {
  client: PlaudClient;
  auth: PlaudAuth;
  config: PlaudConfig;
  region: 'us' | 'eu';
}

/**
 * Build a PlaudConnection from a CredentialStore. Does NOT perform a
 * network round-trip — the first real API call (e.g. listRecordings)
 * is what exercises the token. This function only verifies that a
 * token or credentials are present so we can fail fast.
 *
 * The store must be primed (for KeychainCredentialStore, that means
 * `await store.prime()` has already run) so getCredentials() works
 * synchronously inside @plaud/core.
 */
export function connect(store: CredentialStore): PlaudConnection {
  const config = new PlaudConfig(store);
  const data = config.load();

  const hasToken = data.token !== undefined;
  const hasCredentials = data.credentials !== undefined;
  if (!hasToken && !hasCredentials) {
    throw new PlaudNotAuthenticatedError();
  }

  const region: 'us' | 'eu' = data.credentials?.region ?? 'us';
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, region);
  return { client, auth, config, region };
}

/**
 * Sign in to Plaud with email + password. Saves credentials (password
 * to Keychain via the store), then performs a live login() call to
 * verify them and cache the JWT.
 *
 * Throws on bad credentials or network errors; the caller (IPC handler
 * for the Sources pane) is responsible for reporting them.
 *
 * On success, returns the email + region the user signed in with so
 * the UI can refresh its account display without re-querying.
 */
export async function signInPlaud(
  store: KeychainCredentialStore,
  credentials: PlaudCredentials,
): Promise<{ email: string; region: 'us' | 'eu' }> {
  // Persist credentials first so PlaudAuth.login() reads them via the
  // store. saveCredentialsAsync awaits the Keychain write so any
  // failure surfaces here rather than as a silent fire-and-forget.
  await store.saveCredentialsAsync(credentials);

  const config = new PlaudConfig(store);
  const auth = new PlaudAuth(config);

  // login() POSTs to /auth/access-token, throws on bad creds, and
  // saves the returned JWT into the store on success.
  await auth.login();

  return { email: credentials.email, region: credentials.region };
}

/**
 * Sign out: clear credentials (Keychain entry deleted) and the cached
 * JWT. The user will need to sign in again to use Plaud.
 *
 * Idempotent — safe to call when not signed in.
 */
export async function signOutPlaud(store: KeychainCredentialStore): Promise<void> {
  await store.clearCredentialsAsync();
  store.clearToken();
}

/**
 * Check whether the user is currently signed in. Returns the email +
 * region from the stored credentials, or undefined if not signed in.
 *
 * Does NOT verify the credentials work — that costs a network round-
 * trip. UI uses this for the "signed in as foo@bar.com" affordance;
 * actual authentication errors come through later when the poller or
 * pipeline calls the API.
 */
export function getPlaudAccountStatus(
  store: CredentialStore,
): { signedIn: false } | { signedIn: true; email: string; region: 'us' | 'eu'; tokenExpiresAt: number | null } {
  const config = new PlaudConfig(store);
  const data = config.load();
  if (!data.credentials) {
    return { signedIn: false };
  }
  return {
    signedIn: true,
    email: data.credentials.email,
    region: data.credentials.region,
    tokenExpiresAt: data.token?.expiresAt ?? null,
  };
}

/**
 * Convenience re-export so callers in this package import Plaud types from
 * one place.
 */
export type { PlaudRecording };
