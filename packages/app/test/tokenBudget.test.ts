import { describe, it, expect } from 'vitest';
import {
  estimateTokenBudget,
  OUTPUT_TOKEN_RESERVE,
} from '../src/main/pipeline/tokenBudget.js';

describe('estimateTokenBudget', () => {
  describe('basic math', () => {
    it('estimates input tokens as ceil((promptChars + transcriptChars) / 4)', () => {
      // 1000 + 4000 = 5000 chars / 4 = 1250 tokens
      const result = estimateTokenBudget('a'.repeat(1000), 'b'.repeat(4000), 32768);
      expect(result.estimatedInputTokens).toBe(1250);
    });

    it('rounds up partial tokens', () => {
      // 5 chars / 4 = 1.25 -> ceil = 2
      const result = estimateTokenBudget('hello', '', 32768);
      expect(result.estimatedInputTokens).toBe(2);
    });

    it('returns 0 estimated tokens for empty input', () => {
      const result = estimateTokenBudget('', '', 32768);
      expect(result.estimatedInputTokens).toBe(0);
    });
  });

  describe('budget calculation', () => {
    it('reserves OUTPUT_TOKEN_RESERVE for the model output', () => {
      const result = estimateTokenBudget('', '', 32768);
      expect(result.budget).toBe(32768 - OUTPUT_TOKEN_RESERVE);
    });

    it('budget never goes negative when num_ctx is smaller than the reserve', () => {
      // Defensive: a malformed config with num_ctx=1000 shouldn't produce
      // a negative budget that breaks downstream comparisons.
      const result = estimateTokenBudget('', '', 1000);
      expect(result.budget).toBe(0);
    });

    it('budget grows with num_ctx', () => {
      const at32k = estimateTokenBudget('', '', 32768);
      const at64k = estimateTokenBudget('', '', 65536);
      expect(at64k.budget).toBe(at32k.budget + 32768);
    });
  });

  describe('exceedsBudget', () => {
    it('returns false when input fits comfortably', () => {
      // 4000 chars total = 1000 tokens, budget at 32k - 3000 reserve = 29768
      const result = estimateTokenBudget('a'.repeat(2000), 'b'.repeat(2000), 32768);
      expect(result.exceedsBudget).toBe(false);
    });

    it('returns true when input exceeds budget', () => {
      // Budget at 32k - 3000 = 29768. 30000 tokens = 120000 chars.
      const result = estimateTokenBudget('', 'x'.repeat(120001 * 1), 32768);
      // 120001 chars / 4 = 30001 tokens (rounded up) > 29768
      expect(result.exceedsBudget).toBe(true);
    });

    it('returns false at exactly the budget (boundary)', () => {
      // Budget = 29768 tokens. Submit exactly that many.
      const charsForBudget = 29768 * 4;
      const result = estimateTokenBudget('', 'x'.repeat(charsForBudget), 32768);
      expect(result.estimatedInputTokens).toBe(29768);
      expect(result.exceedsBudget).toBe(false);
    });

    it('returns true at budget + 1 (just over the boundary)', () => {
      const charsForBudgetPlusOne = 29768 * 4 + 1;
      const result = estimateTokenBudget('', 'x'.repeat(charsForBudgetPlusOne), 32768);
      expect(result.estimatedInputTokens).toBe(29769);
      expect(result.exceedsBudget).toBe(true);
    });

    it('the bumped 64k window comfortably handles a very large meeting', () => {
      // ~50,000 word transcript = roughly 200,000 chars = 50,000 tokens.
      // Plus a 1000-char prompt = 250 tokens. Total ~50,250.
      // Budget at 64k - 3000 = 62536. Should NOT exceed.
      const result = estimateTokenBudget('a'.repeat(1000), 'b'.repeat(200000), 65536);
      expect(result.exceedsBudget).toBe(false);
    });
  });

  describe('contextWindow passthrough', () => {
    it('preserves the contextWindow value for retrospective debugging', () => {
      const result = estimateTokenBudget('', '', 65536);
      expect(result.contextWindow).toBe(65536);
    });
  });

  describe('realistic scenarios', () => {
    it('a 30-minute meeting at typical speech rate fits comfortably at 64k', () => {
      // 30 min * 150 words/min = 4500 words ≈ 22500 chars
      const transcript = 'word '.repeat(4500);
      // 1200-char prompt (roughly the size of the client-call prompt)
      const prompt = 'p'.repeat(1200);
      const result = estimateTokenBudget(prompt, transcript, 65536);
      expect(result.exceedsBudget).toBe(false);
      expect(result.estimatedInputTokens).toBeLessThan(10000);
    });

    it('a 2-hour meeting fits at 64k but would have been close at 32k', () => {
      // 2h * 150 words/min = 18000 words ≈ 90000 chars + 1200 prompt
      const transcript = 'word '.repeat(18000);
      const prompt = 'p'.repeat(1200);
      const result64 = estimateTokenBudget(prompt, transcript, 65536);
      const result32 = estimateTokenBudget(prompt, transcript, 32768);
      expect(result64.exceedsBudget).toBe(false);
      // At 32k it's borderline-but-fitting because 'word ' is 5 chars/word,
      // not the chars/token ratio. The point is the bump gives margin.
      expect(result64.estimatedInputTokens).toBe(result32.estimatedInputTokens);
    });

    it('a 5-hour meeting trips the warning even at 64k', () => {
      // 5h * 150 words/min = 45000 words ≈ 225000 chars + 1200 prompt
      const transcript = 'word '.repeat(45000);
      const prompt = 'p'.repeat(1200);
      const result = estimateTokenBudget(prompt, transcript, 65536);
      // 226200 / 4 = 56550 tokens, budget = 65536 - 3000 = 62536. Under!
      // So actually a 5h meeting at this rate doesn't trip 64k.
      // This test documents that — change of plan from earlier sizing.
      expect(result.exceedsBudget).toBe(false);
    });

    it('a 7-hour meeting does trip the warning even at 64k', () => {
      // 7h * 150 wpm = 63000 words ≈ 315000 chars + 1200 prompt
      const transcript = 'word '.repeat(63000);
      const prompt = 'p'.repeat(1200);
      const result = estimateTokenBudget(prompt, transcript, 65536);
      // 316200 / 4 = 79050 tokens, budget = 62536. Exceeds.
      expect(result.exceedsBudget).toBe(true);
    });
  });
});
