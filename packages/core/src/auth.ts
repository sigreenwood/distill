import { PlaudConfig } from './config.js';
import { BASE_URLS, fetchRequester } from './types.js';
import type { PlaudTokenData, Requester } from './types.js';

/** Upper bound on how early we refresh, for long-lived tokens. */
const MAX_TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Refresh once this share of the token's own lifetime remains. */
const TOKEN_REFRESH_FRACTION = 0.1;
/** Fallback when the token carries no usable issued-at claim. */
const FALLBACK_REFRESH_BUFFER_MS = 24 * 60 * 60 * 1000; // 1 day

export class PlaudAuth {
  private config: PlaudConfig;
  private requester: Requester;

  constructor(config: PlaudConfig, requester: Requester = fetchRequester) {
    this.config = config;
    this.requester = requester;
  }

  async getToken(): Promise<string> {
    const cached = this.config.getToken();
    if (cached && !this.isExpiringSoon(cached)) {
      return cached.accessToken;
    }
    return this.login();
  }

  async login(): Promise<string> {
    const creds = this.config.getCredentials();
    if (!creds) {
      throw new Error('No credentials configured. Run `plaud login` first.');
    }

    const baseUrl = BASE_URLS[creds.region] ?? BASE_URLS['us'];
    const body = new URLSearchParams({
      username: creds.email,
      password: creds.password,
    });

    const res = await this.requester({
      url: `${baseUrl}/auth/access-token`,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    // Plaud sits behind Cloudflare, which serves an HTML block page (403)
    // to requests it thinks are bots — e.g. anything with a default Node
    // User-Agent. Surface that as a clear error instead of the JSON
    // parser's "Unexpected token '<'".
    if (!res.ok) {
      throw new Error(
        `Plaud login rejected before reaching the API (HTTP ${res.status}). ` +
          'This is usually bot protection blocking the client — check the request User-Agent.',
      );
    }
    let data: {
      status: number;
      msg?: string;
      access_token: string;
      token_type: string;
    };
    try {
      data = await res.json();
    } catch {
      throw new Error(
        'Plaud login returned a non-JSON response (likely an HTML block or error page).',
      );
    }

    if (data.status !== 0 || !data.access_token) {
      throw new Error(data.msg || `Login failed (status ${data.status})`);
    }

    const decoded = this.decodeJwtExpiry(data.access_token);
    const tokenData: PlaudTokenData = {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      issuedAt: decoded.iat * 1000,
      expiresAt: decoded.exp * 1000,
    };

    this.config.saveToken(tokenData);
    return data.access_token;
  }

  /**
   * Whether the token is close enough to expiry to be worth re-minting.
   *
   * The buffer scales with the token's own lifetime rather than being a
   * flat 30 days. Plaud historically issued ~300-day tokens, for which a
   * flat 30-day buffer was sensible; as of Jul 2026 it issues *30-day*
   * tokens, and a flat 30-day buffer marks those as stale the instant
   * they're minted — so every single API call triggered a full
   * email+password re-login instead of reusing the cached token.
   *
   * Refresh in the last 10% of the token's life, capped at 30 days so
   * long-lived tokens keep the original behaviour.
   */
  private isExpiringSoon(token: PlaudTokenData): boolean {
    const lifetime = token.expiresAt - token.issuedAt;
    const buffer =
      Number.isFinite(lifetime) && lifetime > 0
        ? Math.min(MAX_TOKEN_REFRESH_BUFFER_MS, lifetime * TOKEN_REFRESH_FRACTION)
        : FALLBACK_REFRESH_BUFFER_MS;
    return Date.now() + buffer > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
