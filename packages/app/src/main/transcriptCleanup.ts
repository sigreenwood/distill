/**
 * Transcript noise cleanup.
 *
 * Whisper produces high-quality transcripts most of the time but has
 * predictable failure modes when the audio contains long silences,
 * background music, mumbled speech, or sections where the speaker is
 * eating or drinking. The model "hallucinates" by repeating the last
 * confidently-decoded phrase over and over, sometimes for hundreds of
 * tokens at a stretch.
 *
 * Examples observed in real distill output:
 *
 *   "Repeat Repeat Repeat Repeat Repeat Repeat..."   (50+ times)
 *   "Yeah. Yeah. Yeah. Yeah. Yeah. Yeah..."          (40+ times)
 *   "Thank you. Thank you. Thank you..."             (10+ times)
 *   "I've been so sad. I've been so sad..."          (6+ times)
 *   "I'm going to go back to the Caribbean. I'm going to go back to the Caribbean..."  (4+ times)
 *
 * These pollute three things:
 *   1. The summariser's input (wastes context window, may bias output)
 *   2. The transcript embedded in HTML/Markdown outputs (looks broken)
 *   3. Future search indexes (lots of noise tokens, distorts ranking)
 *
 * This module collapses those repetition runs at the earliest possible
 * point in the pipeline (right after the vocabulary replacements pass,
 * before the row is written to the database). The cleaned text is what
 * everything downstream sees.
 *
 * Cleanup is intentionally conservative: a real speaker repeating "yeah,
 * yeah, yeah" twice or three times is normal conversation and we keep it.
 * The thresholds below collapse only runs that are clearly artefacts
 * (5+ identical phrases in a row).
 */

export interface CleanupResult {
  /** The cleaned transcript text. */
  text: string;
  /** Total number of repetition runs collapsed. */
  runsCollapsed: number;
  /**
   * Total characters removed by collapsing. Useful for telemetry/logging
   * to show how aggressive the cleanup was on a given transcript.
   */
  charsRemoved: number;
}

/**
 * Collapse Whisper repetition artefacts.
 *
 * Strategy: scan for phrases (1 to 6 words) that appear 5 or more times
 * in immediate succession. Replace each run with a single occurrence of
 * the phrase followed by " […]" so the reader knows something was
 * collapsed there. Punctuation between phrases is allowed in the match
 * so "Yeah. Yeah. Yeah." is treated as a run.
 *
 * The implementation uses a single regex that captures a 1-6 word phrase
 * (the "unit") and then matches one-or-more immediate repetitions of
 * that unit, separated only by whitespace and a small set of punctuation.
 * Five total occurrences is the threshold — four repetitions after the
 * initial capture.
 *
 * Why 5+ and not 3+? Three "yeahs" in a row is human conversation. Four
 * is borderline. Five is essentially always a Whisper artefact in
 * practice. Tuning this threshold would be the first lever to pull if
 * users report cleanup either being too aggressive or letting too much
 * noise through.
 *
 * Why max 6 words? Longer sentences also get repeated by Whisper but
 * matching arbitrary-length phrases is exponentially more expensive and
 * the long-phrase failure mode is rarer. 6 words covers the cases I've
 * observed in real transcripts.
 */
export function cleanWhisperRepetitions(text: string): CleanupResult {
  if (!text || text.length === 0) {
    return { text, runsCollapsed: 0, charsRemoved: 0 };
  }

  let runsCollapsed = 0;
  let charsRemoved = 0;
  let cleaned = text;

  // Pass 1: single-word repetitions. We run this BEFORE the multi-word
  // pass because single-word repeats are unambiguous artefacts and
  // running them first prevents the multi-word pattern from matching
  // pairs ("Repeat Repeat") and leaving an odd word stranded at the
  // end ("Repeat Repeat Repeat..." matches as 5 pairs of "Repeat
  // Repeat" and leaves a final lonely "Repeat").
  //
  //   (\b[\w'']+\b)                  capture: single word
  //   (?:[ \t\r\n.,!?]+\1\b){7,}     same word repeated 7+ more times
  //
  // 8+ total occurrences threshold (one capture + seven backreferences):
  // single-word repeats happen naturally in speech ("no, no, no") so
  // we want to be conservative.
  const singleWordPattern = /(\b[\w'']+\b)(?:[ \t\r\n.,!?]+\1\b){7,}/g;
  cleaned = cleaned.replace(singleWordPattern, (match, word: string) => {
    runsCollapsed += 1;
    const replacement = `${word} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });

  // Pass 2: 2-6 word phrase repetitions.
  //
  // Pattern explanation:
  //   ((?:\b[\w'']+\b[ \t]*){2,6}[.,!?]?)   capture: 2-6 words + optional punctuation
  //   (?:[ \t]+\1){4,}                       same group repeated 4+ more times
  //
  // The \1 backreference forces an exact repeat; this is what
  // distinguishes "yeah yeah yeah yeah yeah" (collapsed) from
  // "yeah no yeah no yeah" (left alone).
  //
  // Punctuation handling: many Whisper repetitions look like "Yeah. Yeah.
  // Yeah." — punctuation is part of the unit. We allow trailing
  // .,!? on the captured unit, so the repetition match works whether
  // or not Whisper inserted sentence breaks between repeats.
  const multiWordPattern = /((?:\b[\w'']+\b[ \t]*){2,6}[.,!?]?)(?:[ \t\r\n]+\1){4,}/g;
  cleaned = cleaned.replace(multiWordPattern, (match, unit: string) => {
    runsCollapsed += 1;
    const trimmedUnit = unit.trim();
    const replacement = `${trimmedUnit} […]`;
    charsRemoved += match.length - replacement.length;
    return replacement;
  });

  // Pass 3: collapse triple-or-more whitespace runs left behind by the
  // earlier passes (each replacement may have left a slightly weird gap).
  // Single newlines and double newlines (paragraph breaks) are preserved.
  cleaned = cleaned.replace(/[ \t]{3,}/g, ' ');
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return { text: cleaned, runsCollapsed, charsRemoved };
}
