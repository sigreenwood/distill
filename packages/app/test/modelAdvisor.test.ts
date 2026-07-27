import { describe, it, expect } from 'vitest';
import {
  recommendModelForRam,
  parseModelName,
  successorCandidates,
  checkForNewerGeneration,
} from '../src/main/modelAdvisor.js';

const GB = 1024 * 1024 * 1024;

describe('recommendModelForRam', () => {
  it('recommends the 35B flagship at 48GB and above', () => {
    expect(recommendModelForRam(48 * GB).model).toBe('qwen3.6:35b');
    expect(recommendModelForRam(128 * GB).model).toBe('qwen3.6:35b');
  });

  it('recommends the 27B dense model for 24-36GB', () => {
    expect(recommendModelForRam(24 * GB).model).toBe('qwen3.6:27b');
    expect(recommendModelForRam(36 * GB).model).toBe('qwen3.6:27b');
  });

  it('recommends the 9B model at 16GB', () => {
    expect(recommendModelForRam(16 * GB).model).toBe('qwen3.5:9b');
  });

  it('recommends the 4B model below 16GB', () => {
    expect(recommendModelForRam(8 * GB).model).toBe('qwen3.5:4b');
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
