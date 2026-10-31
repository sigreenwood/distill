import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, State } from '../src/main/state.js';
import { normaliseConfig } from '../src/main/config.js';
import { doSummarise, type PipelineContext } from '../src/main/pipelineSteps.js';

// bundledResources.ts asks Electron where the app lives; under plain Node there is no `app`.
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }));

/**
 * doSummarise end to end against a real (in-memory) database with the real
 * migrations: who writes the summary, what leaves the machine, and what happens
 * when the cloud side fails. The "cloud" is a stand-in script that records
 * everything it is given.
 */
describe('doSummarise routing: local by default, Claude only when allowed', () => {
  let tmp: string;
  let db: DatabaseSync;
  let state: State;
  let ollamaCalls: number;
  let notices: { title: string; body: string }[];
  let logs: { level: string; msg: string; obj: Record<string, unknown> }[];

  const CLAUDE_OK = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: 'CLAUDE SUMMARY', total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20 },
    modelUsage: { 'claude-haiku-4-5-20251001': { outputTokens: 3 }, 'claude-sonnet-4-6': { outputTokens: 20 } },
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'route-'));
    db = new DatabaseSync(':memory:', { allowUnknownNamedParameters: true });
    const adapter = {
      exec: db.exec.bind(db), prepare: db.prepare.bind(db),
      transaction: (fn: (...a: unknown[]) => unknown) => (...a: unknown[]) => {
        db.exec('BEGIN');
        try { const r = fn(...a); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
      },
    } as unknown as ConstructorParameters<typeof State>[0];
    migrate(adapter);
    state = new State(adapter);
    state.upsertClient({ id: 'open', name: 'Open Co', is_builtin: 0, sort_order: 1 });
    state.upsertClient({ id: 'shut', name: 'Shut Co', is_builtin: 0, sort_order: 2 });
    state.setClientClaudeSummaries('open', true);
    db.prepare(`INSERT INTO meeting_types (id, name, prompt, is_builtin, sort_order, created_at, updated_at)
                VALUES ('mt', 'Call', 'PROMPT-MARKER', 0, 1, 0, 0)`).run();
    ollamaCalls = 0;
    notices = [];
    logs = [];
  });

  afterEach(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const addRecording = (id: string, fields: { client_id?: string | null; suggested_client_id?: string | null } = {}) => {
    db.prepare(`INSERT INTO recordings (id, filename, start_time, synced_at, created_at, updated_at, status, client_id, suggested_client_id,
                                        meeting_type_id, transcript_text, source)
                VALUES (?, 'f.mp3', 0, 0, 0, 0, 'summarising', ?, ?, 'mt', 'Others: SECRET TRANSCRIPT', 'local')`)
      .run(id, fields.client_id ?? null, fields.suggested_client_id ?? null);
  };

  /** A stand-in for `claude`: records its args and stdin, then prints `output` and exits `code`. */
  const fakeClaude = (output: string, code = 0): string => {
    const bin = path.join(tmp, 'claude');
    fs.writeFileSync(
      bin,
      `#!/bin/bash\ncat > "${tmp}/stdin.txt"; printf '%s\\n' "$@" > "${tmp}/args.txt"; echo '${output}'; exit ${code}\n`,
      { mode: 0o755 },
    );
    return bin;
  };
  const claudeWasCalled = () => fs.existsSync(path.join(tmp, 'stdin.txt'));

  const ctxWith = (claude: Record<string, unknown> | null, binary: string | null): PipelineContext => {
    const pkg = path.join(tmp, 'pkg', 'python', '.venv', 'bin');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'python'), '');
    const cfg = normaliseConfig(claude ? { claudeSummaries: claude } : {});
    const log = (level: string) => (obj: unknown, msg?: string) => {
      logs.push({ level, msg: msg ?? String(obj), obj: (typeof obj === 'object' && obj ? obj : {}) as Record<string, unknown> });
    };
    return {
      state,
      logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') } as never,
      getConfig: () => cfg,
      plaud: {} as never,
      ollama: { chat: async () => { ollamaCalls++; return { model: 'local-model', message: { content: 'LOCAL SUMMARY' } }; } } as never,
      packageDir: path.join(tmp, 'pkg'),
      findClaude: () => binary,
      notifyUser: (title, body) => notices.push({ title, body }),
    };
  };

  const summarise = (id: string, ctx: PipelineContext) => doSummarise(id, new AbortController().signal, ctx);
  const stored = (id: string) => db.prepare('SELECT summary_text, model_snapshot FROM recordings WHERE id = ?').get(id) as {
    summary_text: string; model_snapshot: string;
  };

  it('migration 25 adds the per-client permission, off for everyone', () => {
    expect(state.getClient('shut')!.claude_summaries).toBe(0);
    expect(state.getClient('open')!.claude_summaries).toBe(1);
    state.upsertClient({ id: 'open', name: 'Open Co', is_builtin: 0, sort_order: 9 }); // a re-seed
    expect(state.getClient('open')!.claude_summaries).toBe(1); // ...does not reset it
  });

  it('with the feature off, never touches Claude even for an allowed client', async () => {
    addRecording('r1', { client_id: 'open' });
    const bin = fakeClaude(CLAUDE_OK);
    await summarise('r1', ctxWith(null, bin));
    expect(claudeWasCalled()).toBe(false);
    expect(stored('r1')).toMatchObject({ summary_text: 'LOCAL SUMMARY', model_snapshot: 'local-model' });
  });

  it('with the feature on, a client that was not allowed stays local', async () => {
    addRecording('r2', { client_id: 'shut' });
    await summarise('r2', ctxWith({ enabled: true }, fakeClaude(CLAUDE_OK)));
    expect(claudeWasCalled()).toBe(false);
    expect(ollamaCalls).toBe(1);
  });

  it('an allowed client goes to Claude: the transcript on stdin, the meeting prompt as the system prompt', async () => {
    addRecording('r3', { client_id: 'open' });
    await summarise('r3', ctxWith({ enabled: true, model: 'sonnet' }, fakeClaude(CLAUDE_OK)));
    expect(ollamaCalls).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'stdin.txt'), 'utf8')).toContain('SECRET TRANSCRIPT');
    const args = fs.readFileSync(path.join(tmp, 'args.txt'), 'utf8');
    expect(args).toContain('--system-prompt\nPROMPT-MARKER');
    expect(args).toContain('--model\nsonnet');
    expect(args).toContain('--no-session-persistence');
    // and it says so: the model on the row names where the words came from
    expect(stored('r3')).toMatchObject({ summary_text: 'CLAUDE SUMMARY', model_snapshot: 'claude-code: claude-sonnet-4-6' });
    expect(logs.some((l) => l.msg.includes('transcript sent to Anthropic'))).toBe(true);
    expect(db.prepare('SELECT model FROM summary_versions WHERE recording_id = ?').get('r3')).toEqual({ model: 'claude-code: claude-sonnet-4-6' });
  });

  it('a SUGGESTED client never grants permission, even an allowed one', async () => {
    addRecording('r4', { client_id: null, suggested_client_id: 'open' });
    await summarise('r4', ctxWith({ enabled: true, forUnfiled: true }, fakeClaude(CLAUDE_OK)));
    expect(claudeWasCalled()).toBe(false);
    expect(ollamaCalls).toBe(1);
  });

  it('an unfiled recording stays local unless that was asked for', async () => {
    addRecording('r5');
    await summarise('r5', ctxWith({ enabled: true }, fakeClaude(CLAUDE_OK)));
    expect(claudeWasCalled()).toBe(false);
    addRecording('r6');
    await summarise('r6', ctxWith({ enabled: true, forUnfiled: true }, fakeClaude(CLAUDE_OK)));
    expect(claudeWasCalled()).toBe(true);
    expect(stored('r6').summary_text).toBe('CLAUDE SUMMARY');
  });

  it('when Claude fails, the summary is written locally, the model on the row says so, and the user is told', async () => {
    addRecording('r7', { client_id: 'open' });
    const bin = fakeClaude('{"is_error":true,"result":"Not logged in · Please run /login"}', 1);
    await summarise('r7', ctxWith({ enabled: true }, bin));
    expect(stored('r7')).toMatchObject({ summary_text: 'LOCAL SUMMARY', model_snapshot: 'local-model' });
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toMatch(/not signed in/i);
    expect(notices[0].body).toMatch(/on this Mac/);
    expect(logs.some((l) => l.level === 'warn' && l.msg.includes('summarising locally instead'))).toBe(true);
  });

  it('falls back locally when Claude Code is not installed at all', async () => {
    addRecording('r8', { client_id: 'open' });
    await summarise('r8', ctxWith({ enabled: true }, null));
    expect(stored('r8').summary_text).toBe('LOCAL SUMMARY');
  });

  it('never goes the other way: if the local model fails, nothing is sent to Claude', async () => {
    addRecording('r9', { client_id: 'shut' });
    const bin = fakeClaude(CLAUDE_OK);
    const ctx = ctxWith({ enabled: true }, bin);
    ctx.ollama = { chat: async () => { throw new Error('Ollama is down'); } } as never;
    await expect(summarise('r9', ctx)).rejects.toThrow(/Ollama is down/);
    expect(claudeWasCalled()).toBe(false);
  });

  it('does not repeat the fallback notification for every recording in a batch', async () => {
    const bin = fakeClaude('{"is_error":true,"result":"usage limit reached"}', 1);
    for (const id of ['b1', 'b2', 'b3']) {
      addRecording(id, { client_id: 'open' });
      await summarise(id, ctxWith({ enabled: true }, bin));
    }
    // The throttle is module-wide, so an earlier test may already have used it: never more than one here.
    expect(notices.length).toBeLessThanOrEqual(1);
    for (const id of ['b1', 'b2', 'b3']) expect(stored(id).summary_text).toBe('LOCAL SUMMARY');
  });

  // Real Claude Code, real network call, a few cents of a pence. Off by default (DISTILL_LIVE_CLAUDE_TEST=1).
  it.skipIf(!process.env.DISTILL_LIVE_CLAUDE_TEST)('LIVE: an allowed client is summarised by the real Claude Code', async () => {
    addRecording('live', { client_id: 'open' });
    const ctx = ctxWith({ enabled: true, model: 'haiku' }, null);
    delete (ctx as { findClaude?: unknown }).findClaude; // use the real search, as the app does
    await summarise('live', ctx);
    expect(ollamaCalls).toBe(0);
    const row = stored('live');
    expect(row.model_snapshot).toMatch(/^claude-code: claude-haiku/);
    expect(row.summary_text.length).toBeGreaterThan(5);
  }, 120_000);
});
