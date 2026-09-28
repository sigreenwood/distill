import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyReplacements, loadVocabulary, type ReplacementRule } from '../src/main/vocabulary.js';

describe('applyReplacements', () => {
  it('replaces at word boundaries, case-insensitively', () => {
    const rules: ReplacementRule[] = [{ from: 'acmee', to: 'Acme' }];
    const { text, applied } = applyReplacements(
      'We deployed Acmee on the new cluster. acmee clusters scale well.',
      rules,
    );
    expect(text).toBe('We deployed Acme on the new cluster. Acme clusters scale well.');
    expect(applied).toBe(1);
  });

  it('does not match inside a word', () => {
    const rules: ReplacementRule[] = [{ from: 'amp', to: 'AMP' }];
    const { text } = applyReplacements('The campfire had an amp next to it.', rules);
    // "camp" should NOT get rewritten because amp is not at word boundary there.
    expect(text).toBe('The campfire had an AMP next to it.');
  });

  it('only applies context-gated rules when context is present', () => {
    const rules: ReplacementRule[] = [
      { from: 'sim', to: 'CIM', requiresContext: ['marketing', 'campaign'] },
    ];

    // No context → no replacement.
    const noCtx = applyReplacements('The phone sim card needs replacing.', rules);
    expect(noCtx.text).toBe('The phone sim card needs replacing.');
    expect(noCtx.applied).toBe(0);

    // Context present → replacement fires.
    const withCtx = applyReplacements(
      'Our marketing team uses sim to manage campaigns.',
      rules,
    );
    expect(withCtx.text).toContain('CIM to manage campaigns');
    expect(withCtx.applied).toBe(1);
  });

  it('context matching is case-insensitive', () => {
    const rules: ReplacementRule[] = [
      { from: 'sif', to: 'CIF', requiresContext: ['customer'] },
    ];
    const { text, applied } = applyReplacements(
      'The Customer Intelligence team built a sif agent.',
      rules,
    );
    expect(text).toContain('CIF agent');
    expect(applied).toBe(1);
  });

  it('handles regex metacharacters in the `from` field safely', () => {
    const rules: ReplacementRule[] = [
      { from: 'I/O', to: 'IO' }, // forward slash is fine but let's also try tricky chars
      { from: 'C++', to: 'C-plus-plus' },
    ];
    const { text } = applyReplacements('We saw I/O spikes in the C++ code path.', rules);
    expect(text).toContain('IO spikes');
    expect(text).toContain('C-plus-plus');
  });

  it('returns input unchanged when no rules match', () => {
    const rules: ReplacementRule[] = [{ from: 'nonexistent', to: 'something' }];
    const input = 'A perfectly ordinary sentence.';
    const { text, applied } = applyReplacements(input, rules);
    expect(text).toBe(input);
    expect(applied).toBe(0);
  });

  it('returns input unchanged when rules array is empty', () => {
    const input = 'Unchanged.';
    const { text, applied } = applyReplacements(input, []);
    expect(text).toBe(input);
    expect(applied).toBe(0);
  });
});

describe('loadVocabulary', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'plaud-vocab-test-'));

    writeFileSync(
      join(tmpDir, 'global.json'),
      JSON.stringify({
        whisperHints: ['Acme Corp', 'Globex'],
        replacements: [{ from: 'globaks', to: 'Globex' }],
      }),
    );

    writeFileSync(
      join(tmpDir, 'organisation.json'),
      JSON.stringify({
        whisperHints: ['Falcon', 'Phoenix'],
        replacements: [{ from: 'fall come', to: 'Falcon' }],
      }),
    );

    writeFileSync(
      join(tmpDir, 'acme-corp.json'),
      JSON.stringify({
        whisperHints: ['Paragon', 'MC'],
        replacements: [{ from: 'paragun', to: 'Paragon' }],
      }),
    );
  });

  it('merges global and organisation when no client is given', () => {
    const v = loadVocabulary(tmpDir, null);
    expect(v.sources).toEqual(['global.json', 'organisation.json']);
    expect(v.whisperPrompt).toContain('Acme Corp');
    expect(v.whisperPrompt).toContain('Phoenix');
    expect(v.replacements).toHaveLength(2);
  });

  it('adds client file when client id matches a file', () => {
    const v = loadVocabulary(tmpDir, 'acme-corp');
    expect(v.sources).toEqual(['global.json', 'organisation.json', 'acme-corp.json']);
    expect(v.whisperPrompt).toContain('Paragon');
    expect(v.replacements).toHaveLength(3);
  });

  it('silently skips a missing client file', () => {
    const v = loadVocabulary(tmpDir, 'unknown-client');
    expect(v.sources).toEqual(['global.json', 'organisation.json']);
  });

  it('produces a non-empty whisper prompt with terms comma-separated', () => {
    const v = loadVocabulary(tmpDir, 'acme-corp');
    expect(v.whisperPrompt).toMatch(/This is a business meeting/);
    expect(v.whisperPrompt).toContain('Acme Corp, Globex');
  });

  it('puts hints before the preamble so a truncated prompt drops the boilerplate, not terms', () => {
    // Whisper truncates the END of an overlong prompt, so the highest-
    // signal content (hints) needs to come first. Pin the order here so
    // a future refactor can't quietly regress it.
    const v = loadVocabulary(tmpDir, 'acme-corp');
    const prompt = v.whisperPrompt;
    const firstHint = prompt.indexOf('Acme Corp');
    const businessMeetingIdx = prompt.indexOf('This is a business meeting');
    expect(firstHint).toBeGreaterThanOrEqual(0);
    expect(businessMeetingIdx).toBeGreaterThan(firstHint);
  });

  it('keeps the prompt under the 800-char cap even with many hints', () => {
    const manyHintsDir = mkdtempSync(join(tmpdir(), 'plaud-vocab-many-'));
    // 200 hints of ~10 chars each ≈ 2400 chars worth of joined text —
    // well over the 800 cap. Verify the cap holds and we still have hints.
    const hints = Array.from({ length: 200 }, (_, i) => `Term${i}NameXY`);
    writeFileSync(
      join(manyHintsDir, 'global.json'),
      JSON.stringify({ whisperHints: hints, replacements: [] }),
    );
    const v = loadVocabulary(manyHintsDir, null);
    expect(v.whisperPrompt.length).toBeLessThanOrEqual(800);
    // First hint preserved (we pack greedy from the start).
    expect(v.whisperPrompt).toContain('Term0NameXY');
    rmSync(manyHintsDir, { recursive: true, force: true });
  });

  it('throws a descriptive error on malformed JSON', () => {
    const bad = mkdtempSync(join(tmpdir(), 'plaud-vocab-bad-'));
    writeFileSync(join(bad, 'global.json'), '{ "not valid json ');
    expect(() => loadVocabulary(bad, null)).toThrow(/Invalid vocabulary file/);
    rmSync(bad, { recursive: true, force: true });
  });
});
