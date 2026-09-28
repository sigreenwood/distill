/**
 * Token budget helpers for the summarise step.
 *
 * Ollama silently truncates the start of an input that exceeds the
 * configured `num_ctx`. The user gets no error, no warning, no log
 * line — just a summary that's missing whatever the start of the
 * meeting was about. To catch this we estimate token usage before
 * submitting and flag rows that would exceed the budget.
 *
 * The estimate uses chars / 4, the conventional rough tokeniser for
 * English text. It's slightly pessimistic for short technical text
 * (where shorter tokens dominate) and slightly optimistic for long
 * sentences with lots of compound words, but it's the right ballpark
 * for meeting transcripts and avoids pulling in a real tokeniser
 * dependency. If the estimate is wrong by 10-15% it still works as
 * a warning — the post-summarise badge is meant to flag risk, not
 * guarantee truncation. The user can re-read the summary against
 * the transcript if the badge fires.
 *
 * The budget reserves a chunk of `num_ctx` for the model's output —
 * the structured summaries the prompts produce can run 1500-3000
 * tokens. Submitting input that fills the entire window leaves no
 * room for the model to respond and produces empty or garbage output.
 * 3000 is a comfortable reserve for the four built-in prompts; user-
 * authored prompts with longer expected outputs can lower the budget
 * by setting a smaller num_ctx if needed.
 */

/** Tokens reserved for the model's output. See module doc. */
export const OUTPUT_TOKEN_RESERVE = 3000;

/**
 * Conventional chars-per-token ratio for English text. 4 is the
 * widely-cited ratio for OpenAI's tokeniser and is close enough for
 * Llama / Qwen / etc. for warning purposes.
 */
const CHARS_PER_TOKEN = 4;

export interface TokenBudget {
  /** Estimated total input tokens (system + user). */
  estimatedInputTokens: number;
  /** Effective budget = `num_ctx - OUTPUT_TOKEN_RESERVE`. */
  budget: number;
  /**
   * True iff `estimatedInputTokens > budget`. When true, Ollama is
   * likely to silently truncate the start of the input and produce a
   * partial summary. The summarise step persists this on the row as
   * `truncation_warning = 1` for the inbox UI to surface.
   */
  exceedsBudget: boolean;
  /** The raw `num_ctx` used in the calculation, for retrospective debugging. */
  contextWindow: number;
}

/**
 * Estimate the token budget for a summarise call.
 *
 * The two text inputs — the system prompt (meeting type) and the user
 * message (transcript) — are summed by character count, divided by
 * four, and rounded up. We do NOT add a per-message overhead (chat
 * formats add a few tokens per message for delimiters); the
 * OUTPUT_TOKEN_RESERVE already provides slack that covers it.
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
