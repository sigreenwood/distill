# plaud-core + plaud-cli + plaud-mcp Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared TypeScript library (`plaud-core`) for the Plaud API with automatic token management, a CLI tool (`plaud-cli`), and an MCP server (`plaud-mcp`).

**Architecture:** Monorepo with three packages sharing a core library. `plaud-core` handles auth (email+password via `POST /auth/access-token`), token caching (300-day tokens auto-refreshed when <30 days remain), and all API calls. `plaud-cli` and `plaud-mcp` are thin wrappers. Credentials stored in `~/.plaud/credentials.json` (mode 0600).

**Tech Stack:** TypeScript, Node.js, tsx (for running TS directly), `@modelcontextprotocol/sdk` for MCP, vitest for tests.

**Plaud API reference (reverse-engineered):**
- Base URLs: `https://api.plaud.ai` (US), `https://api-euc1.plaud.ai` (EU)
- `POST /auth/access-token` — form-encoded `username`+`password` → `{access_token, token_type, status}`
- `POST /auth/otp-send-code` — JSON `{username, user_area}` → `{token}`
- `POST /auth/otp-login` — JSON `{code, token, user_area}` → `{access_token, token_type}`
- `GET /user/me` — user info
- `GET /file/simple/web` — list recordings
- `GET /file/detail/{id}` — recording detail + transcript
- `GET /file/download/{id}` — download audio
- `GET /file/temp-url/{id}?is_opus=false` — MP3 signed URL
- Region mismatch: status `-302` with `data.domains.api` for correct domain
- Token format in header: `Authorization: Bearer <token>`
- Token lifetime: ~300 days (no refresh endpoint, must re-auth)

---

## File Structure

```
plaud/                          # New directory alongside obsidian-plaud
├── package.json                # Monorepo root (workspaces)
├── tsconfig.json               # Shared TS config
├── vitest.config.ts
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts        # Public exports
│   │   │   ├── auth.ts         # Token management (login, store, refresh)
│   │   │   ├── client.ts       # PlaudClient (all API calls)
│   │   │   ├── config.ts       # Config file management (~/.plaud/)
│   │   │   └── types.ts        # Shared types
│   │   └── test/
│   │       ├── auth.test.ts
│   │       └── client.test.ts
│   ├── cli/
│   │   ├── package.json
│   │   ├── bin/plaud.ts        # Entry point
│   │   └── src/
│   │       ├── commands/
│   │       │   ├── login.ts    # plaud login
│   │       │   ├── list.ts     # plaud list
│   │       │   ├── download.ts # plaud download <id>
│   │       │   ├── transcript.ts # plaud transcript <id>
│   │       │   └── sync.ts     # plaud sync <folder>
│   │       └── index.ts        # CLI arg parser
│   └── mcp/
│       ├── package.json
│       └── src/
│           ├── index.ts        # MCP server entry
│           └── tools.ts        # Tool definitions
```

---

## Chunk 1: Project Setup + plaud-core Auth

### Task 1: Initialize monorepo

**Files:**
- Create: `plaud/package.json`
- Create: `plaud/tsconfig.json`
- Create: `plaud/vitest.config.ts`
- Create: `plaud/packages/core/package.json`
- Create: `plaud/packages/core/src/index.ts`

- [ ] **Step 1: Create directory structure**

```bash
cd /Users/tensor/Documents/SV/.obsidian/plugins
mkdir -p plaud/packages/core/src plaud/packages/core/test
mkdir -p plaud/packages/cli/src/commands plaud/packages/cli/bin
mkdir -p plaud/packages/mcp/src
```

- [ ] **Step 2: Create root package.json**

Create `plaud/package.json`:
```json
{
  "name": "plaud",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "vitest": "^3.0.0",
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 3: Create tsconfig.json**

Create `plaud/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "declaration": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["packages/*/src/**/*.ts"]
}
```

- [ ] **Step 4: Create vitest.config.ts**

Create `plaud/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
```

- [ ] **Step 5: Create core package.json**

Create `plaud/packages/core/package.json`:
```json
{
  "name": "@plaud/core",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "vitest run"
  }
}
```

- [ ] **Step 6: Create placeholder index.ts**

Create `plaud/packages/core/src/index.ts`:
```typescript
export { PlaudAuth } from './auth.js';
export { PlaudClient } from './client.js';
export type * from './types.js';
```

- [ ] **Step 7: Install dependencies**

```bash
cd plaud && npm install
```

- [ ] **Step 8: Commit**

```bash
git add plaud/
git commit -m "feat: initialize plaud monorepo with core/cli/mcp structure"
```

---

### Task 2: Core types

**Files:**
- Create: `plaud/packages/core/src/types.ts`

- [ ] **Step 1: Create types file**

Create `plaud/packages/core/src/types.ts`:
```typescript
export interface PlaudCredentials {
  email: string;
  password: string;
  region: 'us' | 'eu';
}

export interface PlaudTokenData {
  accessToken: string;
  tokenType: string;
  issuedAt: number;   // epoch ms
  expiresAt: number;  // epoch ms (decoded from JWT)
}

export interface PlaudConfig {
  credentials?: PlaudCredentials;
  token?: PlaudTokenData;
}

export const BASE_URLS: Record<string, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

export interface PlaudRecording {
  id: string;
  filename: string;
  fullname: string;
  filesize: number;
  duration: number;
  start_time: number;
  end_time: number;
  is_trash: boolean;
  is_trans: boolean;
  is_summary: boolean;
  keywords: string[];
  serial_number: string;
}

export interface PlaudRecordingDetail extends PlaudRecording {
  transcript: string;
  summary?: string;
}

export interface PlaudUserInfo {
  id: string;
  nickname: string;
  email: string;
  country: string;
  membership_type: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add plaud/packages/core/src/types.ts
git commit -m "feat(core): add shared types"
```

---

### Task 3: Config file management

**Files:**
- Create: `plaud/packages/core/src/config.ts`
- Create: `plaud/packages/core/test/config.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plaud/packages/core/test/config.test.ts`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PlaudConfig as Config } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('PlaudConfig', () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-test-'));
    config = new Config(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates config dir if missing', () => {
    const newDir = path.join(tmpDir, 'subdir');
    const c = new Config(newDir);
    c.save({ credentials: { email: 'a@b.com', password: 'x', region: 'eu' } });
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('saves and loads credentials', () => {
    config.save({ credentials: { email: 'test@plaud.ai', password: 'secret', region: 'eu' } });
    const loaded = config.load();
    expect(loaded.credentials?.email).toBe('test@plaud.ai');
    expect(loaded.credentials?.region).toBe('eu');
  });

  it('saves and loads token', () => {
    config.saveToken({ accessToken: 'eyJ...', tokenType: 'Bearer', issuedAt: 1000, expiresAt: 2000 });
    const loaded = config.load();
    expect(loaded.token?.accessToken).toBe('eyJ...');
  });

  it('returns empty config when no file exists', () => {
    const loaded = config.load();
    expect(loaded.credentials).toBeUndefined();
    expect(loaded.token).toBeUndefined();
  });

  it('sets file permissions to 0600', () => {
    config.save({ credentials: { email: 'a@b.com', password: 'x', region: 'us' } });
    const stat = fs.statSync(path.join(tmpDir, 'config.json'));
    const mode = (stat.mode & 0o777).toString(8);
    expect(mode).toBe('600');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plaud && npx vitest run packages/core/test/config.test.ts
```
Expected: FAIL — `PlaudConfig` not found

- [ ] **Step 3: Implement config.ts**

Create `plaud/packages/core/src/config.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PlaudConfig as PlaudConfigData, PlaudCredentials, PlaudTokenData } from './types.js';

const DEFAULT_DIR = path.join(os.homedir(), '.plaud');
const CONFIG_FILE = 'config.json';

export class PlaudConfig {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_DIR;
  }

  private filePath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  load(): PlaudConfigData {
    try {
      const raw = fs.readFileSync(this.filePath(), 'utf-8');
      return JSON.parse(raw) as PlaudConfigData;
    } catch {
      return {};
    }
  }

  save(data: PlaudConfigData): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const existing = this.load();
    const merged = { ...existing, ...data };
    fs.writeFileSync(this.filePath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
  }

  saveToken(token: PlaudTokenData): void {
    this.save({ token });
  }

  saveCredentials(credentials: PlaudCredentials): void {
    this.save({ credentials });
  }

  getToken(): PlaudTokenData | undefined {
    return this.load().token;
  }

  getCredentials(): PlaudCredentials | undefined {
    return this.load().credentials;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plaud && npx vitest run packages/core/test/config.test.ts
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add plaud/packages/core/src/config.ts plaud/packages/core/test/config.test.ts
git commit -m "feat(core): config file management with secure storage"
```

---

### Task 4: Auth with automatic token management

**Files:**
- Create: `plaud/packages/core/src/auth.ts`
- Create: `plaud/packages/core/test/auth.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plaud/packages/core/test/auth.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PlaudAuth } from '../src/auth.js';
import { PlaudConfig } from '../src/config.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('PlaudAuth', () => {
  let tmpDir: string;
  let config: PlaudConfig;
  let auth: PlaudAuth;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-auth-'));
    config = new PlaudConfig(tmpDir);
    config.saveCredentials({ email: 'test@plaud.ai', password: 'pass123', region: 'eu' });
    auth = new PlaudAuth(config);
    mockFetch.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs in with email+password and stores token', async () => {
    // JWT with exp 300 days from now
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: fakeToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);

    // Verify it was stored
    const stored = config.getToken();
    expect(stored?.accessToken).toBe(fakeToken);
  });

  it('returns cached token when still valid', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: futureExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const fakeToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: fakeToken,
      tokenType: 'Bearer',
      issuedAt: Date.now(),
      expiresAt: futureExp * 1000,
    });

    const token = await auth.getToken();
    expect(token).toBe(fakeToken);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refreshes token when expired', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 1000;
    const payload = Buffer.from(JSON.stringify({ sub: 'abc', exp: pastExp, iat: pastExp - 86400 })).toString('base64url');
    const expiredToken = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;

    config.saveToken({
      accessToken: expiredToken,
      tokenType: 'Bearer',
      issuedAt: (pastExp - 86400) * 1000,
      expiresAt: pastExp * 1000,
    });

    const newExp = Math.floor(Date.now() / 1000) + 300 * 86400;
    const newPayload = Buffer.from(JSON.stringify({ sub: 'abc', exp: newExp, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    const newToken = `eyJhbGciOiJIUzI1NiJ9.${newPayload}.sig`;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 0, access_token: newToken, token_type: 'bearer' }),
    });

    const token = await auth.getToken();
    expect(token).toBe(newToken);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('throws when no credentials stored', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-empty-'));
    const emptyConfig = new PlaudConfig(emptyDir);
    const emptyAuth = new PlaudAuth(emptyConfig);

    await expect(emptyAuth.getToken()).rejects.toThrow('No credentials');
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws on wrong credentials', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: -2, msg: 'wrong account or password', access_token: '' }),
    });

    await expect(auth.getToken()).rejects.toThrow('wrong account or password');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plaud && npx vitest run packages/core/test/auth.test.ts
```
Expected: FAIL — `PlaudAuth` not found

- [ ] **Step 3: Implement auth.ts**

Create `plaud/packages/core/src/auth.ts`:
```typescript
import { PlaudConfig } from './config.js';
import { BASE_URLS } from './types.js';
import type { PlaudTokenData } from './types.js';

const TOKEN_REFRESH_BUFFER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class PlaudAuth {
  private config: PlaudConfig;

  constructor(config: PlaudConfig) {
    this.config = config;
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

    const res = await fetch(`${baseUrl}/auth/access-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json() as {
      status: number;
      msg?: string;
      access_token: string;
      token_type: string;
    };

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

  private isExpiringSoon(token: PlaudTokenData): boolean {
    return Date.now() + TOKEN_REFRESH_BUFFER_MS > token.expiresAt;
  }

  private decodeJwtExpiry(jwt: string): { iat: number; exp: number } {
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('Invalid JWT');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return { iat: payload.iat ?? 0, exp: payload.exp ?? 0 };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plaud && npx vitest run packages/core/test/auth.test.ts
```
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add plaud/packages/core/src/auth.ts plaud/packages/core/test/auth.test.ts
git commit -m "feat(core): auth with automatic token management"
```

---

### Task 5: API client

**Files:**
- Create: `plaud/packages/core/src/client.ts`
- Create: `plaud/packages/core/test/client.test.ts`

- [ ] **Step 1: Write failing tests**

Create `plaud/packages/core/test/client.test.ts`:
```typescript
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
    // Store a valid token directly
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

  it('handles region mismatch', async () => {
    // First call returns -302
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: -302,
        data: { domains: { api: 'api-euc1.plaud.ai' } },
      }),
    });
    // Retry with correct region
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd plaud && npx vitest run packages/core/test/client.test.ts
```
Expected: FAIL — `PlaudClient` not found

- [ ] **Step 3: Implement client.ts**

Create `plaud/packages/core/src/client.ts`:
```typescript
import { PlaudAuth } from './auth.js';
import { BASE_URLS } from './types.js';
import type { PlaudRecording, PlaudRecordingDetail, PlaudUserInfo } from './types.js';

export class PlaudClient {
  private auth: PlaudAuth;
  private region: string;

  constructor(auth: PlaudAuth, region: string = 'us') {
    this.auth = auth;
    this.region = region;
  }

  private get baseUrl(): string {
    return BASE_URLS[this.region] ?? BASE_URLS['us'];
  }

  private async request(path: string, options?: RequestInit): Promise<any> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new Error(`Plaud API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();

    // Handle region mismatch
    if (data?.status === -302 && data?.data?.domains?.api) {
      const domain: string = data.data.domains.api;
      this.region = domain.includes('euc1') ? 'eu' : 'us';
      return this.request(path, options);
    }

    return data;
  }

  async listRecordings(): Promise<PlaudRecording[]> {
    const data = await this.request('/file/simple/web');
    const list: PlaudRecording[] = data.data_file_list ?? data.data ?? [];
    return list.filter(r => !r.is_trash);
  }

  async getRecording(id: string): Promise<PlaudRecordingDetail> {
    const data = await this.request(`/file/detail/${id}`);
    const raw = data.data ?? data;

    let transcript = '';
    const preDownload: any[] = raw.pre_download_content_list ?? [];
    for (const item of preDownload) {
      const content = item.data_content ?? '';
      if (content.length > transcript.length) transcript = content;
    }

    return {
      ...raw,
      id: raw.file_id ?? id,
      filename: raw.file_name ?? raw.filename ?? id,
      transcript,
    } as PlaudRecordingDetail;
  }

  async getUserInfo(): Promise<PlaudUserInfo> {
    const data = await this.request('/user/me');
    const user = data.data_user ?? data.data ?? data;
    return {
      id: user.id,
      nickname: user.nickname,
      email: user.email,
      country: user.country,
      membership_type: data.data_state?.membership_type ?? 'unknown',
    };
  }

  async downloadAudio(id: string): Promise<ArrayBuffer> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}/file/download/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return res.arrayBuffer();
  }

  async getMp3Url(id: string): Promise<string | null> {
    try {
      const data = await this.request(`/file/temp-url/${id}?is_opus=false`);
      return data?.url ?? data?.data?.url ?? data?.data ?? data?.temp_url ?? null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd plaud && npx vitest run packages/core/test/client.test.ts
```
Expected: all PASS

- [ ] **Step 5: Update index.ts exports**

Update `plaud/packages/core/src/index.ts`:
```typescript
export { PlaudAuth } from './auth.js';
export { PlaudClient } from './client.js';
export { PlaudConfig } from './config.js';
export type * from './types.js';
```

- [ ] **Step 6: Run all core tests**

```bash
cd plaud && npx vitest run
```
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add plaud/packages/core/
git commit -m "feat(core): API client with recordings, transcripts, downloads"
```

---

## Chunk 2: plaud-cli

### Task 6: CLI framework and login command

**Files:**
- Create: `plaud/packages/cli/package.json`
- Create: `plaud/packages/cli/src/index.ts`
- Create: `plaud/packages/cli/src/commands/login.ts`
- Create: `plaud/packages/cli/bin/plaud.ts`

- [ ] **Step 1: Create CLI package.json**

Create `plaud/packages/cli/package.json`:
```json
{
  "name": "@plaud/cli",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "plaud": "./bin/plaud.ts"
  },
  "dependencies": {
    "@plaud/core": "workspace:*"
  }
}
```

- [ ] **Step 2: Create CLI entry point**

Create `plaud/packages/cli/bin/plaud.ts`:
```typescript
#!/usr/bin/env npx tsx
import { run } from '../src/index.js';
run(process.argv.slice(2));
```

- [ ] **Step 3: Create CLI router**

Create `plaud/packages/cli/src/index.ts`:
```typescript
import { loginCommand } from './commands/login.js';
import { listCommand } from './commands/list.js';
import { downloadCommand } from './commands/download.js';
import { transcriptCommand } from './commands/transcript.js';
import { syncCommand } from './commands/sync.js';

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = {
  login: loginCommand,
  list: listCommand,
  download: downloadCommand,
  transcript: transcriptCommand,
  sync: syncCommand,
};

export async function run(args: string[]): Promise<void> {
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printUsage();
    return;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args.slice(1));
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`Usage: plaud <command> [options]

Commands:
  login                 Save your Plaud credentials
  list                  List recordings
  download <id> [dir]   Download audio file
  transcript <id>       Print transcript
  sync <folder>         Download all new recordings to folder`);
}
```

- [ ] **Step 4: Create login command**

Create `plaud/packages/cli/src/commands/login.ts`:
```typescript
import * as readline from 'readline';
import { PlaudConfig, PlaudAuth } from '@plaud/core';

export async function loginCommand(_args: string[]): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, resolve));

  try {
    const email = await ask('Plaud email: ');
    const password = await ask('Password: ');
    const regionInput = await ask('Region (us/eu) [eu]: ');
    const region = (regionInput.trim() || 'eu') as 'us' | 'eu';

    const config = new PlaudConfig();
    config.saveCredentials({ email: email.trim(), password, region });

    console.log('Credentials saved. Verifying...');

    const auth = new PlaudAuth(config);
    const token = await auth.login();
    console.log(`Login successful! Token valid for ~300 days.`);
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 5: Create placeholder commands**

Create `plaud/packages/cli/src/commands/list.ts`:
```typescript
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

function createClient(): PlaudClient {
  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  return new PlaudClient(auth, creds?.region ?? 'eu');
}

export async function listCommand(_args: string[]): Promise<void> {
  const client = createClient();
  const recordings = await client.listRecordings();

  if (recordings.length === 0) {
    console.log('No recordings found.');
    return;
  }

  for (const rec of recordings) {
    const date = new Date(rec.start_time).toISOString().slice(0, 16).replace('T', ' ');
    const dur = rec.duration ? `${Math.round(rec.duration / 60000)}m` : '?';
    const flags = [rec.is_trans ? 'T' : '', rec.is_summary ? 'S' : ''].filter(Boolean).join('');
    console.log(`${rec.id}  ${date}  ${dur.padStart(4)}  ${flags.padEnd(2)}  ${rec.filename}`);
  }

  console.log(`\n${recordings.length} recording(s)`);
}
```

Create `plaud/packages/cli/src/commands/transcript.ts`:
```typescript
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

export async function transcriptCommand(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    console.error('Usage: plaud transcript <recording-id>');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  const detail = await client.getRecording(id);

  if (detail.transcript && detail.transcript.length > 0) {
    console.log(detail.transcript);
  } else {
    console.log('No transcript available for this recording.');
  }
}
```

Create `plaud/packages/cli/src/commands/download.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

export async function downloadCommand(args: string[]): Promise<void> {
  const id = args[0];
  const dir = args[1] || '.';
  if (!id) {
    console.error('Usage: plaud download <recording-id> [directory]');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  // Try MP3 first
  const mp3Url = await client.getMp3Url(id);
  let buffer: ArrayBuffer;
  let ext = 'opus';

  if (mp3Url) {
    console.log('Downloading MP3...');
    const res = await fetch(mp3Url);
    buffer = await res.arrayBuffer();
    ext = 'mp3';
  } else {
    console.log('Downloading audio...');
    buffer = await client.downloadAudio(id);
  }

  fs.mkdirSync(dir, { recursive: true });
  const filename = `${id}.${ext}`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, Buffer.from(buffer));
  console.log(`Saved: ${filepath} (${(buffer.byteLength / 1024).toFixed(0)} KB)`);
}
```

Create `plaud/packages/cli/src/commands/sync.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';

export async function syncCommand(args: string[]): Promise<void> {
  const folder = args[0];
  if (!folder) {
    console.error('Usage: plaud sync <folder>');
    process.exit(1);
  }

  const config = new PlaudConfig();
  const creds = config.getCredentials();
  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds?.region ?? 'eu');

  fs.mkdirSync(folder, { recursive: true });

  const recordings = await client.listRecordings();
  console.log(`Found ${recordings.length} recording(s). Checking for new ones...`);

  let synced = 0;
  for (const rec of recordings) {
    const date = new Date(rec.start_time).toISOString().slice(0, 10);
    const slug = rec.filename?.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 50) || rec.id;
    const mdFile = path.join(folder, `${date}_${slug}.md`);

    if (fs.existsSync(mdFile)) continue;

    console.log(`Syncing: ${rec.filename} (${rec.id})...`);
    const detail = await client.getRecording(rec.id);

    const content = [
      '---',
      `plaud_id: ${rec.id}`,
      `title: "${rec.filename}"`,
      `date: ${date}`,
      `duration: ${Math.round(rec.duration / 60000)}m`,
      `source: plaud`,
      '---',
      '',
      `# ${rec.filename}`,
      '',
      detail.transcript || '*(No transcript available)*',
    ].join('\n');

    fs.writeFileSync(mdFile, content);
    synced++;
  }

  console.log(synced > 0 ? `Synced ${synced} new recording(s).` : 'Already up to date.');
}
```

- [ ] **Step 6: Install and test CLI**

```bash
cd plaud && npm install
npx tsx packages/cli/bin/plaud.ts --help
```
Expected: prints usage

- [ ] **Step 7: Commit**

```bash
git add plaud/packages/cli/
git commit -m "feat(cli): plaud CLI with login, list, download, transcript, sync"
```

---

## Chunk 3: plaud-mcp

### Task 7: MCP server

**Files:**
- Create: `plaud/packages/mcp/package.json`
- Create: `plaud/packages/mcp/src/index.ts`
- Create: `plaud/packages/mcp/src/tools.ts`

- [ ] **Step 1: Create MCP package.json**

Create `plaud/packages/mcp/package.json`:
```json
{
  "name": "@plaud/mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "bin": {
    "plaud-mcp": "./src/index.ts"
  },
  "dependencies": {
    "@plaud/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  }
}
```

- [ ] **Step 2: Create tool definitions**

Create `plaud/packages/mcp/src/tools.ts`:
```typescript
import { PlaudClient } from '@plaud/core';

export function defineTools(client: PlaudClient) {
  return {
    plaud_list_recordings: {
      description: 'List all Plaud recordings with ID, date, duration, and title.',
      parameters: {},
      handler: async () => {
        const recs = await client.listRecordings();
        return recs.map(r => ({
          id: r.id,
          title: r.filename,
          date: new Date(r.start_time).toISOString().slice(0, 16),
          duration_minutes: Math.round(r.duration / 60000),
          has_transcript: r.is_trans,
        }));
      },
    },

    plaud_get_transcript: {
      description: 'Get the transcript of a Plaud recording by ID.',
      parameters: {
        type: 'object' as const,
        properties: {
          recording_id: { type: 'string', description: 'The recording ID' },
        },
        required: ['recording_id'],
      },
      handler: async (params: { recording_id: string }) => {
        const detail = await client.getRecording(params.recording_id);
        return {
          id: detail.id,
          title: detail.filename,
          transcript: detail.transcript || 'No transcript available.',
        };
      },
    },

    plaud_get_recording_detail: {
      description: 'Get full details of a Plaud recording including metadata and transcript.',
      parameters: {
        type: 'object' as const,
        properties: {
          recording_id: { type: 'string', description: 'The recording ID' },
        },
        required: ['recording_id'],
      },
      handler: async (params: { recording_id: string }) => {
        return client.getRecording(params.recording_id);
      },
    },

    plaud_user_info: {
      description: 'Get current Plaud user information.',
      parameters: {},
      handler: async () => {
        return client.getUserInfo();
      },
    },

    plaud_get_mp3_url: {
      description: 'Get a temporary download URL for the MP3 version of a recording.',
      parameters: {
        type: 'object' as const,
        properties: {
          recording_id: { type: 'string', description: 'The recording ID' },
        },
        required: ['recording_id'],
      },
      handler: async (params: { recording_id: string }) => {
        const url = await client.getMp3Url(params.recording_id);
        return { url: url || null, message: url ? 'Temporary URL valid for a short time.' : 'No MP3 available.' };
      },
    },
  };
}
```

- [ ] **Step 3: Create MCP server entry**

Create `plaud/packages/mcp/src/index.ts`:
```typescript
#!/usr/bin/env npx tsx
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PlaudConfig, PlaudAuth, PlaudClient } from '@plaud/core';
import { defineTools } from './tools.js';

async function main() {
  const config = new PlaudConfig();
  const creds = config.getCredentials();

  if (!creds) {
    console.error('No Plaud credentials found. Run `plaud login` first.');
    process.exit(1);
  }

  const auth = new PlaudAuth(config);
  const client = new PlaudClient(auth, creds.region);
  const tools = defineTools(client);

  const server = new McpServer({
    name: 'plaud-mcp',
    version: '0.1.0',
  });

  // Register tools
  for (const [name, tool] of Object.entries(tools)) {
    const paramSchema = Object.keys(tool.parameters).length > 0
      ? tool.parameters
      : { type: 'object' as const, properties: {} };

    server.tool(name, tool.description, paramSchema, async (params: any) => {
      try {
        const result = await tool.handler(params);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
```

- [ ] **Step 4: Install MCP dependencies**

```bash
cd plaud && npm install
```

- [ ] **Step 5: Test MCP server starts**

```bash
cd plaud && echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | npx tsx packages/mcp/src/index.ts 2>/dev/null | head -1
```
Expected: JSON response with server capabilities (or credentials error if not logged in)

- [ ] **Step 6: Commit**

```bash
git add plaud/packages/mcp/
git commit -m "feat(mcp): MCP server exposing Plaud recordings and transcripts"
```

---

## Chunk 4: Integration test and docs

### Task 8: End-to-end integration test

**Files:**
- Create: `plaud/packages/core/test/integration.test.ts`

- [ ] **Step 1: Write integration test (skipped unless credentials exist)**

Create `plaud/packages/core/test/integration.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { PlaudConfig, PlaudAuth, PlaudClient } from '../src/index.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HAS_CREDS = fs.existsSync(path.join(os.homedir(), '.plaud', 'config.json'));

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
```

- [ ] **Step 2: Run all tests**

```bash
cd plaud && npx vitest run
```
Expected: unit tests PASS, integration tests SKIP (or PASS if `~/.plaud/config.json` exists)

- [ ] **Step 3: Commit**

```bash
git add plaud/packages/core/test/integration.test.ts
git commit -m "test: add live API integration tests"
```

---

### Task 9: README and MCP config example

**Files:**
- Create: `plaud/README.md`

- [ ] **Step 1: Create README**

Create `plaud/README.md`:
```markdown
# plaud

TypeScript toolkit for the Plaud API: core library, CLI, and MCP server.

## Setup

```bash
cd plaud && npm install
```

### 1. Login

```bash
npx tsx packages/cli/bin/plaud.ts login
```

Enter your email, password, and region. Credentials are stored in `~/.plaud/config.json`.

> **Note:** If you use Google Sign-In on Plaud, first set a password via "Forgot Password" on web.plaud.ai.

### 2. CLI Usage

```bash
# List recordings
npx tsx packages/cli/bin/plaud.ts list

# Get transcript
npx tsx packages/cli/bin/plaud.ts transcript <recording-id>

# Download audio
npx tsx packages/cli/bin/plaud.ts download <recording-id> ./audio/

# Sync all recordings to a folder
npx tsx packages/cli/bin/plaud.ts sync ./plaud-notes/
```

### 3. MCP Server

Add to your Claude config (`~/.claude.json` or Obsidian CLAUDE.md):

```json
{
  "mcpServers": {
    "plaud": {
      "command": "npx",
      "args": ["tsx", "/path/to/plaud/packages/mcp/src/index.ts"]
    }
  }
}
```

Tools available:
- `plaud_list_recordings` — list all recordings
- `plaud_get_transcript` — get transcript by recording ID
- `plaud_get_recording_detail` — full recording metadata
- `plaud_user_info` — account info
- `plaud_get_mp3_url` — temporary MP3 download URL

## Token Management

Tokens are obtained automatically via email+password and last ~300 days. The library refreshes silently when a token is within 30 days of expiry. No manual intervention needed after initial `plaud login`.
```

- [ ] **Step 2: Commit**

```bash
git add plaud/README.md
git commit -m "docs: add README with CLI and MCP setup instructions"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Monorepo setup | Root config files |
| 2 | Core types | `core/src/types.ts` |
| 3 | Config management | `core/src/config.ts` + tests |
| 4 | Auth + auto token | `core/src/auth.ts` + tests |
| 5 | API client | `core/src/client.ts` + tests |
| 6 | CLI (all commands) | `cli/` package |
| 7 | MCP server | `mcp/` package |
| 8 | Integration tests | `core/test/integration.test.ts` |
| 9 | README | `plaud/README.md` |
