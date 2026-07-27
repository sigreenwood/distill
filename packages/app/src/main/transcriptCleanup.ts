export interface CleanupResult {
  text: string;
  runsCollapsed: number;
  charsRemoved: number;
}

/**
 * Whisper sometimes gets stuck in a loop and emits the same word or short
 * phrase dozens of times ("hallucinated repetition"). Collapse long runs to
 * a single instance plus an ellipsis marker so summaries aren't polluted.
 *
 * Thresholds are deliberately high (8+ repeats of a single word, 5+ of a
 * multi-word unit) so legitimate emphasis ("no, no, no") survives.
 */
export function cleanWhisperRepetitions(text: string): CleanupResult {
  if (!text || text.length === 0) {
    return { text, runsCollapsed: 0, charsRemoved: 0 };
  }
  let runsCollapsed = 0;
  let charsRemoved = 0;
  let cleaned = text;

  const singleWordPattern = /(\b[\w'’]+\b)(?:[ \t\r\n.,!?]+\1\b){7,}/g;
  cleaned = cleaned.replace(singleWordPattern, (match, word: string) => {
    runsCollapsed += 1;
    const replacement = `${word} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });

  const multiWordPattern = /((?:\b[\w'’]+\b[ \t]*){2,6}[.,!?]?)(?:[ \t\r\n]+\1){4,}/g;
  cleaned = cleaned.replace(multiWordPattern, (match, unit: string) => {
    runsCollapsed += 1;
    const trimmedUnit = unit.trim();
    const replacement = `${trimmedUnit} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });

  cleaned = cleaned.replace(/[ \t]{3,}/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return { text: cleaned, runsCollapsed, charsRemoved };
}
