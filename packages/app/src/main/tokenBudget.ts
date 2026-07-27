/** Tokens reserved for the model's own output within num_ctx. */
const OUTPUT_TOKEN_RESERVE = 3000;
/** Rough chars-per-token for English conversational text. */
const CHARS_PER_TOKEN = 4;

export interface TokenBudget {
  estimatedInputTokens: number;
  budget: number;
  exceedsBudget: boolean;
  contextWindow: number;
}

/**
 * Estimate whether prompt + transcript fit in Ollama's context window.
 * When they don't, Ollama silently truncates the START of the input —
 * the summary quietly loses the beginning of the meeting — so the
 * summarise step records a truncation warning the inbox can surface.
 */
export function estimateTokenBudget(
  promptText: string,
  transcriptText: string,
  contextWindow: number,
): TokenBudget {
  const totalChars = promptText.length + transcriptText.length;
  const estimatedInputTokens = Math.ceil(totalChars / CHARS_PER_TOKEN);
  const budget = Math.max(0, contextWindow - OUTPUT_TOKEN_RESERVE);
  return {
    estimatedInputTokens,
    budget,
    exceedsBudget: estimatedInputTokens > budget,
    contextWindow,
  };
}
