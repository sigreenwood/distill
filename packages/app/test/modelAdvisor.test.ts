import { describe, it, expect } from 'vitest';
import { resolveContextWindow } from '../src/main/config.js';
import {
  recommendModelForRam,
  parseModelName,
  successorCandidates,
  checkForNewerGeneration,
  recommendContextWindow,
} from '../src/main/modelAdvisor.js';

const GB = 1024 * 1024 * 1024;

describe('recommendModelForRam', () => {
  it('recommends the 35B flagship only with real headroom', () => {
    expect(recommendModelForRam(64 * GB).model).toBe('qwen3.6:35b');
    expect(recommendModelForRam(128 * GB).model).toBe('qwen3.6:35b');
  });

  it('recommends the 27B dense model from 36GB up', () => {
    expect(recommendModelForRam(36 * GB).model).toBe('qwen3.6:27b');
    expect(recommendModelForRam(48 * GB).model).toBe('qwen3.6:27b');
  });

  it('does NOT recommend a 27B on a 24GB Mac', () => {
    // Regression: the tiers used to ask "do the weights fit?" and put a
    // 27B here. Measured on that hardware it swapped to 9.4GB and
    // generated at 0.57 tok/s — it fits and is unusable.
    const rec = recommendModelForRam(24 * GB);
    expect(rec.model).toBe('qwen3.5:9b');
    expect(rec.model).not.toMatch(/27b|35b/);
  });

  it('steps down further on smaller machines', () => {
    expect(recommendModelForRam(16 * GB).model).toBe('qwen3.5:4b');
    expect(recommendModelForRam(8 * GB).model).toBe('qwen3.5:2b');
  });
});

describe('parseModelName', () => {
  it('parses family, version, and size tag', () => {
    expect(parseModelName('qwen3.6:27b')).toEqual({ family: 'qwen', version: [3, 6], tag: '27b' });
  });

  it('parses a major-only version', () => {
    expect(parseModelName('qwen3:14b')).toEqual({ family: 'qwen', version: [3], tag: '14b' });
  });

  it('parses an unversioned family with no tag', () => {
    expect(parseModelName('llama')).toEqual({ family: 'llama', version: null, tag: '' });
  });
});

describe('successorCandidates', () => {
  it('proposes next minors then next major for x.y versions', () => {
    const parsed = parseModelName('qwen3.6:27b')!;
    expect(successorCandidates(parsed)).toEqual(['qwen3.7', 'qwen3.8', 'qwen4', 'qwen4.5']);
  });

  it('proposes half-step and next major for major-only versions', () => {
    const parsed = parseModelName('qwen3:14b')!;
    expect(successorCandidates(parsed)).toEqual(['qwen3.5', 'qwen4']);
  });

  it('proposes nothing for unversioned names', () => {
    const parsed = parseModelName('llama')!;
    expect(successorCandidates(parsed)).toEqual([]);
  });
});

describe('checkForNewerGeneration', () => {
  const probeExisting = (existing: string[]) => async (url: string) => {
    const name = url.split('/').pop()!;
    return existing.includes(name) ? { status: 200, ok: true } : { status: 404, ok: false };
  };

  it('suggests the next minor generation, keeping the size tag', async () => {
    const s = await checkForNewerGeneration('qwen3.6:27b', probeExisting(['qwen3.7']));
    expect(s).not.toBeNull();
    expect(s!.newFamily).toBe('qwen3.7');
    expect(s!.suggestedModel).toBe('qwen3.7:27b');
  });

  it('prefers the newest existing candidate when several exist', async () => {
    const s = await checkForNewerGeneration('qwen3.6:27b', probeExisting(['qwen3.7', 'qwen4']));
    expect(s!.newFamily).toBe('qwen4');
    expect(s!.suggestedModel).toBe('qwen4:27b');
  });

  it('returns null when nothing newer exists', async () => {
    const s = await checkForNewerGeneration('qwen3.6:27b', probeExisting([]));
    expect(s).toBeNull();
  });

  it('treats probe failures as not-found instead of throwing', async () => {
    const s = await checkForNewerGeneration('qwen3.6:27b', async () => {
      throw new Error('offline');
    });
    expect(s).toBeNull();
  });
});

describe('recommendContextWindow', () => {
  it('allows 64k only where memory supports it', () => {
    expect(recommendContextWindow(48 * GB)).toBe(65536);
    expect(recommendContextWindow(64 * GB)).toBe(65536);
  });

  it('caps a 24GB Mac at 32k (64k killed Ollama in practice)', () => {
    expect(recommendContextWindow(24 * GB)).toBe(32768);
  });

  it('scales down further on smaller machines', () => {
    expect(recommendContextWindow(16 * GB)).toBe(16384);
    expect(recommendContextWindow(8 * GB)).toBe(8192);
  });
});

describe('resolveContextWindow', () => {
  it('defaults to the memory-appropriate window', () => {
    expect(resolveContextWindow(undefined, 24 * GB)).toBe(32768);
    expect(resolveContextWindow(undefined, 48 * GB)).toBe(65536);
  });

  it('keeps 32k on a 24GB Mac instead of bumping it to 64k', () => {
    // Regression: the legacy bump keyed on the exact value 32768, so a
    // user setting 32k by hand had it silently restored to 64k — the
    // very config that kills Ollama on this hardware.
    expect(resolveContextWindow(32768, 24 * GB)).toBe(32768);
  });

  it('still applies the legacy 32k→64k bump where memory allows', () => {
    expect(resolveContextWindow(32768, 48 * GB)).toBe(65536);
  });

  it('passes through any other explicit value untouched', () => {
    expect(resolveContextWindow(16384, 24 * GB)).toBe(16384);
    expect(resolveContextWindow(131072, 48 * GB)).toBe(131072);
  });
});
