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
