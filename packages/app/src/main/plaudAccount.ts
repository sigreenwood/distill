import { PlaudAuth, PlaudClient, PlaudConfig } from '@plaud/core';
import type { CredentialStore, PlaudCredentials } from '@plaud/core';

export class PlaudNotAuthenticatedError extends Error {
  constructor() {
    super('Plaud is not authenticated. Open Settings -> Sources and sign in to Plaud.');
    this.name = 'PlaudNotAuthenticatedError';
  }
}

export interface PlaudConnection {
  client: PlaudClient;
  auth: PlaudAuth;
  config: PlaudConfig;
  region: string;
}

export type PlaudAccountStatus =
  | { signedIn: false }
  | { signedIn: true; email: string; region: string; tokenExpiresAt: number | null };

/**
 * Build an authenticated Plaud client from the given credential store.
 * Throws PlaudNotAuthenticatedError when neither a token nor credentials
 * exist — callers surface that as a "sign in" prompt, not a crash.
 */
export function connect(store: CredentialStore): PlaudConnection {
  const config = new PlaudConfig(store);
  const data = config.load();
  const hasToken = data.token !== undefined;
  const hasCredentials = data.credentials !== undefined;
  if (!hasToken && !hasCredentials) {
    throw new PlaudNotAuthenticatedError();
  }
  const region = data.credentials?.region ?? 'us';
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, region);
  return { client, auth, config, region };
}

export async function signInPlaud(
  store: CredentialStore & { saveCredentialsAsync(c: PlaudCredentials): Promise<void> },
  credentials: PlaudCredentials,
): Promise<{ email: string; region: string }> {
  await store.saveCredentialsAsync(credentials);
  const config = new PlaudConfig(store);
  const auth = new PlaudAuth(config);
  await auth.login();
  return { email: credentials.email, region: credentials.region };
}

export async function signOutPlaud(
  store: CredentialStore & { clearCredentialsAsync(): Promise<void> },
): Promise<void> {
  await store.clearCredentialsAsync();
  store.clearToken();
}

export function getPlaudAccountStatus(store: CredentialStore): PlaudAccountStatus {
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
