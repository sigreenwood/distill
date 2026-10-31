import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withToolDirs } from './toolPath.js';
import { normaliseClaudeModel } from './summaryProvider.js';

export { normaliseClaudeModel };

/**
 * Summarising with Claude Code (`claude -p`), as an opt-in alternative to
 * Ollama. See docs/app/CLAUDE-SUMMARIES.md.
 *
 * This sends the transcript to Anthropic, which is the one thing the rest of
 * distill is built never to do, so this module only runs a call; the decision
 * to make one lives in summaryProvider.ts, and is off unless the user turned
 * it on for that client.
 *
 * Claude Code is driven as a plain text-in, text-out summariser. A bare
 * `claude -p` is NOT that: it loads the user's own CLAUDE.md, settings, hooks
 * and tools into the request (measured: a note from ~/.claude/CLAUDE.md was
 * quoted back, and the call cost ~9x more in tokens). The flags in claudeArgs
 * switch all of it off. `--bare` would too, but it is API-key-only and ignores
 * the subscription login, which is how most people have Claude Code set up.
 */

export type ClaudeFailure = 'not-installed' | 'not-logged-in' | 'limit' | 'timeout' | 'failed';

/** `userMessage` is safe to show as-is. */
export class ClaudeCodeError extends Error {
  userMessage: string;
  kind: ClaudeFailure;
  constructor(kind: ClaudeFailure, userMessage: string) {
    super(userMessage);
    this.name = 'ClaudeCodeError';
    this.kind = kind;
    this.userMessage = userMessage;
  }
}

// --- finding the binary ----------------------------------------------------

/**
 * Where Claude Code lives. An app launched from Finder has launchd's PATH, which
 * has none of these, so they are searched explicitly: the native installer's
 * ~/.local/bin and ~/.claude/local, then Homebrew and npm/bun/volta globals.
 */
export function claudeSearchDirs(home: string, pathEnv: string | undefined): string[] {
  const fromPath = (pathEnv ?? '').split(':').filter((p) => p.length > 0);
  const known = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
  ];
  return [...new Set([...fromPath, ...known])];
}

export function findClaudeBinary(
  home: string = os.homedir(),
  pathEnv: string | undefined = process.env.PATH,
  isExecutable: (p: string) => boolean = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
): string | null {
  for (const dir of claudeSearchDirs(home, pathEnv)) {
    const candidate = path.join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

// --- arguments ---------------------------------------------------------------

/**
 * The isolated, no-tools invocation. Verified against Claude Code 2.1.123: with
 * these flags a probe for text from the user's CLAUDE.md came back empty and the
 * request was ~190 input tokens; without them it was ~11,000.
 *
 * The meeting type's prompt is the system prompt (replacing Claude Code's own),
 * the transcript goes in on stdin.
 */
export function claudeArgs(opts: { systemPrompt: string; model: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'json',
    '--system-prompt', opts.systemPrompt,
    '--tools', '',
    '--no-session-persistence',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
  ];
  const model = normaliseClaudeModel(opts.model);
  if (model) args.push('--model', model);
  return args;
}

// --- reading the result ------------------------------------------------------

export interface ClaudeResult {
  text: string;
  /** The model that wrote the summary, e.g. "claude-sonnet-4-6". */
  model: string;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
}

const NOT_LOGGED_IN =
  /not logged in|please run \/login|invalid api key|authentication[_ ]|oauth token|unauthori[sz]ed|\b401\b/i;
const LIMIT = /usage limit|rate[ _-]?limit|limit reached|overloaded|too many requests|credit balance|\b429\b|\b529\b|quota/i;

export function classifyClaudeError(message: string): ClaudeCodeError {
  const m = message.trim();
  if (NOT_LOGGED_IN.test(m)) {
    return new ClaudeCodeError(
      'not-logged-in',
      'Claude Code is not signed in. Open Terminal, run `claude`, and sign in (type /login), then try again.',
    );
  }
  if (LIMIT.test(m)) {
    return new ClaudeCodeError(
      'limit',
      'Claude is rate-limited or over its usage limit right now. Try again later, or switch this client back to local summaries.',
    );
  }
  return new ClaudeCodeError('failed', `Claude Code could not summarise this: ${m.slice(0, 300) || 'no details given'}`);
}

/**
 * `claude -p --output-format json` prints one JSON object. Claude Code also runs
 * a small model for housekeeping, so `modelUsage` has more than one entry; the
 * summary's model is the one that wrote the most.
 */
export function parseClaudeOutput(stdout: string): ClaudeResult {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(stdout.trim()) as Record<string, unknown>;
  } catch {
    throw new ClaudeCodeError('failed', 'Claude Code returned something distill could not read.');
  }
  const text = typeof d.result === 'string' ? d.result.trim() : '';
  if (d.is_error === true || (typeof d.subtype === 'string' && d.subtype.startsWith('error'))) {
    throw classifyClaudeError(text || String(d.subtype ?? ''));
  }
  if (!text) throw new ClaudeCodeError('failed', 'Claude Code returned an empty summary.');

  const usage = (typeof d.modelUsage === 'object' && d.modelUsage !== null ? d.modelUsage : {}) as Record<
    string,
    { outputTokens?: number; inputTokens?: number }
  >;
  let model = 'claude';
  let most = -1;
  for (const [name, u] of Object.entries(usage)) {
    const out = typeof u?.outputTokens === 'number' ? u.outputTokens : 0;
    if (out > most) {
      most = out;
      model = name;
    }
  }
  const u = (typeof d.usage === 'object' && d.usage !== null ? d.usage : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    text,
    model,
    costUsd: typeof d.total_cost_usd === 'number' ? d.total_cost_usd : null,
    inputTokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    outputTokens: num(u.output_tokens),
  };
}

// --- running it --------------------------------------------------------------

function abortError(): Error {
  const e = new Error('Claude Code call cancelled');
  e.name = 'AbortError'; // what cancellation.ts isCancelled() recognises
  return e;
}

interface RunOptions {
  binary: string;
  args: string[];
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

interface RunOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** An empty working directory, so nothing in a project folder can be picked up. */
function neutralCwd(): string {
  const dir = path.join(os.tmpdir(), 'distill-claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function run(o: RunOptions): Promise<RunOutput> {
  return new Promise((resolve, reject) => {
    if (o.signal?.aborted) return reject(abortError());
    const proc = spawn(o.binary, o.args, {
      cwd: neutralCwd(),
      env: { ...process.env, PATH: withToolDirs(process.env.PATH) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => {
      proc.kill('SIGTERM');
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      finish(() =>
        reject(
          new ClaudeCodeError(
            'timeout',
            `Claude Code did not answer within ${Math.round(o.timeoutMs / 60000)} minutes.`,
          ),
        ),
      );
    }, o.timeoutMs);
    o.signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout.on('data', (c) => (stdout += String(c)));
    proc.stderr.on('data', (c) => (stderr = (stderr + String(c)).slice(-8000)));
    proc.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          e.code === 'ENOENT'
            ? new ClaudeCodeError('not-installed', 'Claude Code was not found. Install it, then try again (see docs/app/CLAUDE-SUMMARIES.md).')
            : new ClaudeCodeError('failed', `Could not start Claude Code: ${e.message}`),
        ),
      ),
    );
    proc.on('close', (code) => finish(() => resolve({ code, stdout, stderr })));
    proc.stdin.on('error', () => {}); // it may exit before reading everything; the exit code says why
    proc.stdin.end(o.stdin ?? '');
  });
}

export interface SummariseOptions {
  binary: string;
  systemPrompt: string;
  userContent: string;
  /** '' = whatever Claude Code defaults to. */
  model: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function summariseWithClaudeCode(o: SummariseOptions): Promise<ClaudeResult> {
  const out = await run({
    binary: o.binary,
    args: claudeArgs({ systemPrompt: o.systemPrompt, model: o.model }),
    stdin: o.userContent,
    signal: o.signal,
    timeoutMs: o.timeoutMs ?? 10 * 60_000,
  });
  // A failed call usually still prints a JSON error object; prefer its message.
  if (out.stdout.trim().startsWith('{')) return parseClaudeOutput(out.stdout);
  if (out.code !== 0) throw classifyClaudeError(out.stderr || `exit code ${out.code}`);
  return parseClaudeOutput(out.stdout);
}

// --- status ------------------------------------------------------------------

export interface ClaudeStatus {
  installed: boolean;
  binary: string | null;
  version: string | null;
  loggedIn: boolean;
  /** "claude.ai" (a subscription) or "api-key" etc., as Claude Code reports it. */
  authMethod: string | null;
  subscription: string | null;
  email: string | null;
  /** Why it is not usable, in words for the user. */
  problem: string | null;
}

export async function getClaudeStatus(binary: string | null = findClaudeBinary()): Promise<ClaudeStatus> {
  const none: ClaudeStatus = {
    installed: false, binary: null, version: null, loggedIn: false,
    authMethod: null, subscription: null, email: null,
    problem: 'Claude Code is not installed (or not where distill can find it).',
  };
  if (!binary) return none;
  const base = { ...none, installed: true, binary, problem: null as string | null };
  try {
    const v = await run({ binary, args: ['--version'], timeoutMs: 15_000 });
    base.version = v.stdout.trim().split('\n')[0] || null;
    const a = await run({ binary, args: ['auth', 'status'], timeoutMs: 20_000 });
    const s = JSON.parse(a.stdout.trim() || '{}') as Record<string, unknown>;
    base.loggedIn = s.loggedIn === true;
    base.authMethod = typeof s.authMethod === 'string' ? s.authMethod : null;
    base.subscription = typeof s.subscriptionType === 'string' ? s.subscriptionType : null;
    base.email = typeof s.email === 'string' ? s.email : null;
    if (!base.loggedIn) base.problem = 'Claude Code is installed but not signed in. Run `claude` in Terminal and type /login.';
  } catch (e) {
    base.problem = `Claude Code is installed but did not respond properly (${e instanceof Error ? e.message : String(e)}).`;
  }
  return base;
}
