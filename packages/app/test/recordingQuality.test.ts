import { describe, expect, it } from 'vitest';
import { recordingQualityWarning } from '../src/shared/recordingQuality.js';

describe('recordingQualityWarning', () => {
  it('flags the 6 Oct wrong-microphone call (23% speech, 11 words a minute)', () => {
    const w = recordingQualityWarning({ speechRatio: 0.229, durationSeconds: 3261, words: 600 });
    expect(w).toContain('23% of the recording was speech');
    expect(w).toContain('11 words a minute');
    expect(w).toContain('wrong microphone');
  });

  it('leaves normal meetings alone (median 91% speech, ~120 words a minute)', () => {
    expect(recordingQualityWarning({ speechRatio: 0.91, durationSeconds: 1800, words: 3600 })).toBeNull();
    // The lowest normal recordings in the calibration set (~65%, ~90 wpm).
    expect(recordingQualityWarning({ speechRatio: 0.65, durationSeconds: 3540, words: 5400 })).toBeNull();
  });

  it('flags few words even when VAD did not run, but not very short clips', () => {
    expect(recordingQualityWarning({ speechRatio: null, durationSeconds: 1200, words: 300 })).not.toBeNull();
    expect(recordingQualityWarning({ speechRatio: 0.1, durationSeconds: 60, words: 5 })).toBeNull();
  });
});
