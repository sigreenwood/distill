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

/** Smallest num_ctx this app will ever request, regardless of how short the input is. */
export const MIN_ADAPTIVE_CONTEXT = 8192;
/** Rounding granularity for the adaptive value, so nearby transcript lengths converge on the same number rather than each provoking a distinct Ollama (re)allocation. */
const ADAPTIVE_CONTEXT_STEP = 4096;

/**
 * Size num_ctx to what one summarise call actually needs instead of
 * always allocating `ceiling`'s full KV cache, even for a 10-minute
 * meeting. Still bounded by `ceiling` — a transcript that needs more
 * than that relies on the existing truncation warning exactly as
 * before; this never raises the effective limit, only lowers the
 * typical cost of staying under it. See OllamaConfig.adaptiveContextWindow.
 */
export function computeAdaptiveContextWindow(estimatedInputTokens: number, ceiling: number): number {
  const needed = estimatedInputTokens + OUTPUT_TOKEN_RESERVE;
  const rounded = Math.ceil(needed / ADAPTIVE_CONTEXT_STEP) * ADAPTIVE_CONTEXT_STEP;
  return Math.min(ceiling, Math.max(MIN_ADAPTIVE_CONTEXT, rounded));
}
