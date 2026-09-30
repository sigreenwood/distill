import { describe, expect, it } from 'vitest';
import { computeAdaptiveContextWindow, estimateTokenBudget, MIN_ADAPTIVE_CONTEXT } from '../src/main/tokenBudget.js';

describe('estimateTokenBudget', () => {
  it('estimates input tokens from combined prompt + transcript length at 4 chars/token', () => {
    const budget = estimateTokenBudget('x'.repeat(400), 'y'.repeat(400), 65536);
    expect(budget.estimatedInputTokens).toBe(200);
    expect(budget.contextWindow).toBe(65536);
  });

  it('reserves output tokens from the ceiling and flags when input exceeds what remains', () => {
    // budget = 8192 - 3000 = 5192 tokens = 20768 chars; push just over it.
    const budget = estimateTokenBudget('', 'x'.repeat(20772), 8192);
    expect(budget.budget).toBe(5192);
    expect(budget.exceedsBudget).toBe(true);
  });

  it('never reports a negative budget for a tiny ceiling', () => {
    expect(estimateTokenBudget('', 'x', 100).budget).toBe(0);
  });
});

describe('computeAdaptiveContextWindow', () => {
  it('never goes below the minimum, even for a near-empty transcript', () => {
    expect(computeAdaptiveContextWindow(10, 65536)).toBe(MIN_ADAPTIVE_CONTEXT);
  });

  it('rounds up to the step so nearby lengths converge on the same value', () => {
    // 8192 + 3000 reserve = 11192 -> rounds up to 12288 (next 4096 multiple).
    expect(computeAdaptiveContextWindow(8192, 65536)).toBe(12288);
    expect(computeAdaptiveContextWindow(8200, 65536)).toBe(12288);
  });

  it('never exceeds the configured ceiling, however large the transcript', () => {
    expect(computeAdaptiveContextWindow(1_000_000, 65536)).toBe(65536);
  });

  it('matches the ceiling exactly when the ceiling itself is smaller than the minimum', () => {
    // A deliberately tiny ceiling should still be respected as the hard cap.
    expect(computeAdaptiveContextWindow(10, 4096)).toBe(4096);
  });
});
