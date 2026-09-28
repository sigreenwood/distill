import { describe, it, expect } from 'vitest';
import { prettifyError } from '../src/main/errorMessages.js';

describe('prettifyError', () => {
  it('detects Ollama not running (ECONNREFUSED on default port)', () => {
    const out = prettifyError('fetch failed: connect ECONNREFUSED 127.0.0.1:11434');
    expect(out.message).toContain('Ollama is not running');
    expect(out.message).toContain('ollama serve');
    expect(out.isAuthError).toBe(false);
  });

  it('detects missing Ollama model and uses the configured model name', () => {
    const out = prettifyError('Ollama 404: {"error":"model \\"qwen2.5:32b\\" not found"}', {
      ollamaModel: 'qwen2.5:32b',
    });
    expect(out.message).toContain('qwen2.5:32b');
    expect(out.message).toContain('ollama pull qwen2.5:32b');
    expect(out.isAuthError).toBe(false);
  });

  it('falls back to a generic model reference if no model is given', () => {
    const out = prettifyError('model "mystery" not found');
    // With no context model, the rule still fires but uses a placeholder.
    expect(out.message).toContain('Ollama model');
    expect(out.message).toContain('ollama pull');
  });

  it('flags expired Plaud auth on 401 and tags it as an auth error', () => {
    const out = prettifyError('Download failed: HTTP 401');
    expect(out.message).toContain('auth expired');
    // After the in-app sign-in landed in commit 8b80e9a, the message
    // points at Settings -> Sources rather than the CLI's plaud login.
    expect(out.message).toContain('Settings');
    expect(out.message).toContain('Sources');
    expect(out.isAuthError).toBe(true);
  });

  it('flags missing Plaud credentials as an auth error', () => {
    const out = prettifyError('No credentials configured. Run `plaud login` first.');
    expect(out.message).toContain('Not signed in');
    expect(out.isAuthError).toBe(true);
  });

  it('suggests skipping when Plaud returns 404', () => {
    const out = prettifyError('Download failed: HTTP 404');
    expect(out.message).toContain('deleted server-side');
    expect(out.message).toContain('skip');
    expect(out.isAuthError).toBe(false);
  });

  it('explains transcription exit codes', () => {
    const out = prettifyError('Transcription failed (exit -9): killed');
    expect(out.message).toContain('Transcription crashed');
    expect(out.message).toContain('-9');
  });

  it('handles disk-full', () => {
    const out = prettifyError('ENOSPC: no space left on device');
    expect(out.message).toContain('Disk is full');
  });

  it('handles DNS failure', () => {
    const out = prettifyError('getaddrinfo ENOTFOUND api.plaud.ai');
    expect(out.message).toContain('DNS lookup failed');
  });

  it('returns unknown errors largely untouched', () => {
    const out = prettifyError('Something completely unexpected went wrong');
    expect(out.message).toBe('Something completely unexpected went wrong');
    expect(out.isAuthError).toBe(false);
  });

  it('trims long unknown errors to the first line at 200 chars', () => {
    const longFirstLine = 'x'.repeat(500);
    const out = prettifyError(longFirstLine + '\nstack trace line 2\nstack trace line 3');
    expect(out.message.length).toBeLessThanOrEqual(200);
    expect(out.message).toMatch(/…$/);
  });

  it('keeps short first lines unchanged even with a long stack trace', () => {
    const out = prettifyError(
      'TypeError: undefined is not a function\n    at foo (bar.ts:123)\n    at baz (qux.ts:456)',
    );
    expect(out.message).toBe('TypeError: undefined is not a function');
  });

  it('handles empty input gracefully', () => {
    const a = prettifyError('');
    const b = prettifyError('   ');
    expect(a.message).toBe('Unknown error');
    expect(a.isAuthError).toBe(false);
    expect(b.message).toBe('Unknown error');
    expect(b.isAuthError).toBe(false);
  });
});
