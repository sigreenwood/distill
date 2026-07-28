import { describe, it, expect } from 'vitest';
import { buildWhisperPrompt } from '../src/main/vocabulary.js';

const ANCHOR = 'Good morning';

describe('buildWhisperPrompt', () => {
  it('still returns a style anchor when no vocabulary is configured', () => {
    // Regression: this returned '' with no hints, so no initial_prompt was
    // passed at all. Measured effect on a real call's opening: 0.6%
    // uppercase and zero sentence marks, plus a name ("Aris") mangled to
    // "rs". The anchor is worth having on its own.
    const p = buildWhisperPrompt([]);
    expect(p).not.toBe('');
    expect(p).toContain(ANCHOR);
  });

  it('demonstrates punctuation rather than instructing about it', () => {
    // Whisper continues from the prompt, it does not follow instructions,
    // so the anchor has to BE well-formed prose.
    const p = buildWhisperPrompt([]);
    expect(p).toMatch(/[.!?]/);
    expect(p).toMatch(/[A-Z]/);
    expect(p.toLowerCase()).not.toContain('use proper punctuation');
  });

  it('puts hints first, then the anchor', () => {
    const p = buildWhisperPrompt(['Teradata', 'Biocatch']);
    expect(p.indexOf('Teradata')).toBeLessThan(p.indexOf(ANCHOR));
    expect(p).toContain('Teradata, Biocatch');
  });

  it('keeps the anchor when hints overflow the budget', () => {
    const many = Array.from({ length: 400 }, (_, i) => `TermNumber${i}`);
    const p = buildWhisperPrompt(many);
    expect(p.length).toBeLessThanOrEqual(800);
    expect(p).toContain(ANCHOR);
  });

  it('falls back to the anchor alone when even one hint will not fit', () => {
    const p = buildWhisperPrompt(['x'.repeat(900)]);
    expect(p).toBe(buildWhisperPrompt([]));
  });
});
