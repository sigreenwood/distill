/**
 * A warning for recordings that captured little speech: the wrong
 * microphone selected, or a call whose other side the recorder couldn't
 * hear. Calibrated on 177 real recordings (Aug–Oct 2026): normally ~91% of
 * a recording is speech (median; 5th percentile 65%) at 90–130 transcript
 * words a minute. A call recorded on the wrong microphone (6 Oct) had 23%
 * speech and 11 words a minute; of 151 recordings over 10 minutes, only 3
 * fell below 50%, all of them broken or near-empty.
 */
export const MIN_SPEECH_RATIO = 0.5;
export const MIN_WORDS_PER_MINUTE = 40;

export interface QualityInput {
  /** Share of the audio the VAD kept as speech, 0–1; null when VAD didn't run. */
  speechRatio: number | null;
  durationSeconds: number | null;
  /** Words in the cleaned transcript. */
  words: number;
}

export function recordingQualityWarning(input: QualityInput): string | null {
  const minutes = (input.durationSeconds ?? 0) / 60;
  const lowSpeech = input.speechRatio !== null && minutes >= 2 && input.speechRatio < MIN_SPEECH_RATIO;
  const wpm = minutes > 0 ? input.words / minutes : null;
  const fewWords = wpm !== null && minutes >= 5 && wpm < MIN_WORDS_PER_MINUTE;
  if (!lowSpeech && !fewWords) return null;
  const parts: string[] = [];
  if (input.speechRatio !== null) parts.push(`${Math.round(input.speechRatio * 100)}% of the recording was speech`);
  if (wpm !== null) parts.push(`${Math.round(wpm)} words a minute`);
  return (
    `Little speech was captured (${parts.join(', ')}). The recorder may have used the wrong microphone ` +
    `or not heard the other side, so the transcript and summary are likely incomplete.`
  );
}
