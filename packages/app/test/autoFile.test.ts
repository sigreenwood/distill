import { describe, expect, it } from 'vitest';
import { autoFileDecision, type AutoFileInput } from '../src/shared/filing.js';
import { normaliseConfig } from '../src/main/config.js';

const sure: AutoFileInput = {
  confidence: 'high',
  suggestedClientId: 'hsbc',
  calendarClientId: 'hsbc',
  meetingTypeRetired: false,
  summaryTitle: 'Weekly sync on upgrade plans',
};

describe('autoFileDecision', () => {
  it('files a high-confidence match the calendar confirms, or that only the transcript supports', () => {
    expect(autoFileDecision(sure)).toEqual({ file: true, reason: 'high confidence, confirmed by the calendar' });
    expect(autoFileDecision({ ...sure, calendarClientId: null }).file).toBe(true);
  });

  it('holds anything less for the user', () => {
    expect(autoFileDecision({ ...sure, confidence: 'medium' }).file).toBe(false);
    expect(autoFileDecision({ ...sure, confidence: null }).file).toBe(false);
    expect(autoFileDecision({ ...sure, suggestedClientId: null }).file).toBe(false);
    expect(autoFileDecision({ ...sure, suggestedClientId: 'unclassified' }).file).toBe(false);
    expect(autoFileDecision({ ...sure, calendarClientId: 'aib' })).toEqual({
      file: false,
      reason: 'the calendar points to a different account',
    });
    expect(autoFileDecision({ ...sure, meetingTypeRetired: true }).file).toBe(false);
    expect(autoFileDecision({ ...sure, summaryTitle: 'No meeting content recorded' }).file).toBe(false);
  });
});

describe('autoFileHighConfidence', () => {
  it('is off unless the user turns it on', () => {
    expect(normaliseConfig({}).autoFileHighConfidence).toBe(false);
    expect(normaliseConfig({ autoFileHighConfidence: 'yes' } as never).autoFileHighConfidence).toBe(false);
    expect(normaliseConfig({ autoFileHighConfidence: true } as never).autoFileHighConfidence).toBe(true);
  });
});

describe('minimum recording length', () => {
  it('treats only known, shorter recordings as too short', async () => {
    const { isTooShort } = await import('../src/shared/filing.js');
    expect(isTooShort(90, 2)).toBe(true);
    expect(isTooShort(120, 2)).toBe(false);
    expect(isTooShort(null, 2)).toBe(false);
    expect(isTooShort(30, 0)).toBe(false);
  });

  it('accepts whole minutes from 0 to 120, otherwise keeps everything', () => {
    expect(normaliseConfig({}).minRecordingMinutes).toBe(0);
    expect(normaliseConfig({ minRecordingMinutes: 3 } as never).minRecordingMinutes).toBe(3);
    expect(normaliseConfig({ minRecordingMinutes: 2.5 } as never).minRecordingMinutes).toBe(0);
    expect(normaliseConfig({ minRecordingMinutes: 500 } as never).minRecordingMinutes).toBe(0);
  });
});
