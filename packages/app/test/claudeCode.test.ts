import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeArgs,
  claudeSearchDirs,
  findClaudeBinary,
  normaliseClaudeModel,
  parseClaudeOutput,
  classifyClaudeError,
  summariseWithClaudeCode,
  getClaudeStatus,
  ClaudeCodeError,
} from '../src/main/claudeCode.js';

const ok = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '  **Decisions**\n- Ship it  ',
    total_cost_usd: 0.0028,
    usage: { input_tokens: 276, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 98 },
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 15 },
      'claude-sonnet-4-6': { outputTokens: 98 },
    },
    ...over,
  });

describe('claudeArgs', () => {
  const a = claudeArgs({ systemPrompt: 'SYS', model: '' });

  it('switches off everything that would add the user\'s own context to the request', () => {
    expect(a).toContain('--no-session-persistence');
    expect(a).toContain('--disable-slash-commands');
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('never uses --bare (API-key only) or leaves the default tools on', () => {
    expect(a).not.toContain('--bare');
    expect(a[a.indexOf('--tools') + 1]).not.toBe('default');
  });

  it('passes the prompt as the system prompt and asks for JSON', () => {
    expect(a[a.indexOf('--system-prompt') + 1]).toBe('SYS');
    expect(a[a.indexOf('--output-format') + 1]).toBe('json');
  });

  it('adds --model only when one is set, and only a plain identifier', () => {
    expect(a).not.toContain('--model');
    expect(claudeArgs({ systemPrompt: 'S', model: 'sonnet' })).toContain('--model');
    expect(claudeArgs({ systemPrompt: 'S', model: '--dangerously-skip-permissions' })).not.toContain('--model');
    expect(claudeArgs({ systemPrompt: 'S', model: 'sonnet; rm -rf /' })).not.toContain('--model');
  });
});

describe('normaliseClaudeModel', () => {
  it('accepts aliases, full names and the 1m suffix; rejects anything else', () => {
    for (const m of ['sonnet', 'opus', 'haiku', 'claude-sonnet-4-6', 'opus[1m]']) expect(normaliseClaudeModel(m)).toBe(m);
    for (const m of ['', ' ', '-x', 'a b', 'a;b', '$(x)', 5, null, undefined]) expect(normaliseClaudeModel(m)).toBe('');
  });
});

describe('finding the binary', () => {
  it('searches PATH first, then the places a Finder-launched app cannot see', () => {
    const dirs = claudeSearchDirs('/Users/u', '/usr/bin:/bin');
    expect(dirs.slice(0, 2)).toEqual(['/usr/bin', '/bin']);
    expect(dirs).toContain('/Users/u/.local/bin');
    expect(dirs).toContain('/opt/homebrew/bin');
    expect(new Set(dirs).size).toBe(dirs.length);
  });

  it('returns the first executable and null when there is none', () => {
    const only = (p: string) => p === '/Users/u/.local/bin/claude';
    expect(findClaudeBinary('/Users/u', '/usr/bin', only)).toBe('/Users/u/.local/bin/claude');
    expect(findClaudeBinary('/Users/u', '/usr/bin', () => false)).toBeNull();
  });
});

describe('parseClaudeOutput', () => {
  it('returns the summary and the model that wrote it, not the housekeeping model', () => {
    const r = parseClaudeOutput(ok());
    expect(r.text).toBe('**Decisions**\n- Ship it');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.inputTokens).toBe(291);
    expect(r.outputTokens).toBe(98);
    expect(r.costUsd).toBeCloseTo(0.0028);
  });

  it('classifies the failures a user can act on', () => {
    const fail = (result: string) => () => parseClaudeOutput(JSON.stringify({ is_error: true, result }));
    expect(fail('Not logged in · Please run /login')).toThrowError(expect.objectContaining({ kind: 'not-logged-in' }));
    expect(fail('Claude AI usage limit reached')).toThrowError(expect.objectContaining({ kind: 'limit' }));
    expect(fail('API Error: 529 overloaded')).toThrowError(expect.objectContaining({ kind: 'limit' }));
    expect(fail('something odd')).toThrowError(expect.objectContaining({ kind: 'failed' }));
  });

  it('rejects empty, malformed and error-subtype output', () => {
    expect(() => parseClaudeOutput(ok({ result: '   ' }))).toThrow(/empty/);
    expect(() => parseClaudeOutput('not json')).toThrow(ClaudeCodeError);
    expect(() => parseClaudeOutput(ok({ subtype: 'error_max_turns', result: 'x' }))).toThrow(ClaudeCodeError);
  });

  it('does not mistake numbers in an ordinary error for a status code', () => {
    expect(classifyClaudeError('failed after 4290 ms').kind).toBe('failed');
  });
});

// Real processes standing in for the CLI.
describe('running a call', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const fake = (body: string): string => {
    const p = path.join(tmp, 'claude');
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return p;
  };
  const base = { systemPrompt: 'SYS', userContent: 'USER TEXT', model: '' };

  it('feeds the transcript on stdin and the prompt as an argument, and reads the JSON back', async () => {
    const dump = path.join(tmp, 'seen.json');
    const bin = fake(`cat > "${dump}.stdin"; printf '%s\\n' "$@" > "${dump}.args"; echo '${ok()}'`);
    const r = await summariseWithClaudeCode({ ...base, binary: bin, model: 'sonnet' });
    expect(r.text).toContain('Ship it');
    expect(fs.readFileSync(`${dump}.stdin`, 'utf8')).toBe('USER TEXT');
    const args = fs.readFileSync(`${dump}.args`, 'utf8');
    expect(args).toContain('--system-prompt\nSYS');
    expect(args).toContain('--model\nsonnet');
  });

  it('survives a large transcript (a long meeting)', async () => {
    const big = 'word '.repeat(200_000); // ~1 MB
    const bin = fake(`wc -c > "${tmp}/n"; echo '${ok()}'`);
    await summariseWithClaudeCode({ ...base, binary: bin, userContent: big });
    expect(Number(fs.readFileSync(`${tmp}/n`, 'utf8').trim())).toBe(big.length);
  });

  it('uses the error message Claude Code printed, even on a non-zero exit', async () => {
    const bin = fake(`echo '{"is_error":true,"result":"Not logged in · Please run /login"}'; exit 1`);
    await expect(summariseWithClaudeCode({ ...base, binary: bin })).rejects.toMatchObject({ kind: 'not-logged-in' });
  });

  it('falls back to stderr when there is no JSON at all', async () => {
    const bin = fake(`echo "Error: usage limit reached" >&2; exit 1`);
    await expect(summariseWithClaudeCode({ ...base, binary: bin })).rejects.toMatchObject({ kind: 'limit' });
  });

  it('reports a binary that is not there', async () => {
    await expect(summariseWithClaudeCode({ ...base, binary: path.join(tmp, 'nope') })).rejects.toMatchObject({ kind: 'not-installed' });
  });

  it('gives up on a hung call and stops the process', async () => {
    const bin = fake(`echo $$ > "${tmp}/pid"; sleep 30`);
    await expect(summariseWithClaudeCode({ ...base, binary: bin, timeoutMs: 400 })).rejects.toMatchObject({ kind: 'timeout' });
    await new Promise((r) => setTimeout(r, 300));
    const pid = Number(fs.readFileSync(`${tmp}/pid`, 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
  });

  it('can be cancelled, as AbortError so the pipeline treats it as a cancel', async () => {
    const bin = fake(`sleep 30`);
    const ac = new AbortController();
    const p = summariseWithClaudeCode({ ...base, binary: bin, signal: ac.signal });
    setTimeout(() => ac.abort(), 150);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not even start when already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(summariseWithClaudeCode({ ...base, binary: fake('echo hi'), signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('getClaudeStatus', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const fake = (body: string) => { const p = path.join(tmp, 'claude'); fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 }); return p; };

  it('says so when it is not installed', async () => {
    const s = await getClaudeStatus(null);
    expect(s.installed).toBe(false);
    expect(s.problem).toMatch(/not installed/);
  });

  it('reads version and sign-in state', async () => {
    const bin = fake(`if [ "$1" = "--version" ]; then echo "2.1.123 (Claude Code)"; else echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro","email":"a@b.c"}'; fi`);
    const s = await getClaudeStatus(bin);
    expect(s).toMatchObject({ installed: true, version: '2.1.123 (Claude Code)', loggedIn: true, authMethod: 'claude.ai', subscription: 'pro', email: 'a@b.c', problem: null });
  });

  it('explains how to fix a missing login', async () => {
    const bin = fake(`if [ "$1" = "--version" ]; then echo 2.1.123; else echo '{"loggedIn":false}'; fi`);
    const s = await getClaudeStatus(bin);
    expect(s.loggedIn).toBe(false);
    expect(s.problem).toMatch(/\/login/);
  });
});

// Real Claude Code, real network call, real (tiny, synthetic) cost. Off by default.
describe.skipIf(!process.env.DISTILL_LIVE_CLAUDE_TEST)('live Claude Code', () => {
  it('summarises a synthetic transcript through the isolated invocation', async () => {
    const bin = findClaudeBinary();
    expect(bin).not.toBeNull();
    const r = await summariseWithClaudeCode({
      binary: bin!,
      systemPrompt: 'Summarise in one short bullet list. Only use facts in the transcript.',
      userContent: 'Others: We launch on the 15th of March.\n\nYou: Agreed, budget permitting.',
      model: 'haiku',
    });
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.model).toMatch(/haiku/);
    // Isolation: the user's own ~/.claude/CLAUDE.md must not be in the request.
    expect(r.inputTokens).toBeLessThan(1500);
  }, 120_000);
});
