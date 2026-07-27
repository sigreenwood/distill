import { describe, it, expect } from 'vitest';
import { prettifyError } from '../src/main/errorMessages.js';

describe('prettifyError fallback for unmatched errors', () => {
  it('does not stop before the reason on multi-line tool output', () => {
    // Real failure: the fallback used to return only the first line, so
    // the message ended on a colon and never said what went wrong.
    const raw =
      'Partial output failure (2/3 attempted succeeded this run). appleNotes: osascript failed (exit 9):\n' +
      '51:66: execution error: Notes got an error: Something specific broke. (-9999)';
    const { message } = prettifyError(raw);
    expect(message).not.toMatch(/:$/);
    expect(message).toContain('Something specific broke');
  });

  it('flattens whitespace into one readable sentence', () => {
    const { message } = prettifyError('first line\n\n   second line   \nthird line');
    expect(message).toBe('first line second line third line');
  });

  it('truncates very long output rather than flooding the row', () => {
    const { message } = prettifyError('x'.repeat(500));
    expect(message.length).toBeLessThanOrEqual(240);
    expect(message.endsWith('…')).toBe(true);
  });

  it('falls back to a readable string for empty input', () => {
    expect(prettifyError('   ').message).toBe('Unknown error');
  });
});

describe('prettifyError known causes', () => {
  it('explains an Ollama connection death as a memory problem', () => {
    const { message } = prettifyError('fetch failed', { ollamaModel: 'qwen3.5:27b' });
    expect(message).toMatch(/contextWindow|memory/i);
    expect(message).toContain('qwen3.5:27b');
  });

  it('explains an Apple Notes timeout without claiming the note failed', () => {
    const { message } = prettifyError(
      'osascript failed (exit 1): execution error: Notes got an error: AppleEvent timed out. (-1712)',
    );
    expect(message).toMatch(/may still have been created/i);
  });

  it('flags auth failures so the inbox can offer a sign-in button', () => {
    const { isAuthError } = prettifyError('Download failed: HTTP 401');
    expect(isAuthError).toBe(true);
  });
});
