import { describe, expect, it } from 'vitest';
import { normaliseConfig, normaliseProcessingSchedule } from '../src/main/config.js';

describe('normaliseConfig — adaptiveContextWindow', () => {
  it('defaults to enabled for a fresh config', () => {
    expect(normaliseConfig({}).ollama.adaptiveContextWindow).toBe(true);
  });

  it('honours an explicit false without being coerced back on', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: false } }).ollama.adaptiveContextWindow).toBe(false);
  });

  it('honours an explicit true', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: true } }).ollama.adaptiveContextWindow).toBe(true);
  });

  it('falls back to the default for a garbage value rather than throwing', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: 'yes' } }).ollama.adaptiveContextWindow).toBe(true);
  });
});

describe('normaliseConfig — processingSchedule', () => {
  it('defaults to immediate processing for a fresh config', () => {
    expect(normaliseConfig({}).processingSchedule).toEqual({
      mode: 'immediate', idleMinutes: 15, overnightStart: '22:00', overnightEnd: '06:00',
    });
  });

  it('round-trips a fully-specified schedule', () => {
    const schedule = { mode: 'overnight', idleMinutes: 20, overnightStart: '23:30', overnightEnd: '07:15' };
    expect(normaliseConfig({ processingSchedule: schedule }).processingSchedule).toEqual(schedule);
  });
});

describe('normaliseProcessingSchedule', () => {
  it('rejects an invalid mode, idleMinutes, or time format by falling back per-field', () => {
    expect(normaliseProcessingSchedule({ mode: 'whenever' }).mode).toBe('immediate');
    expect(normaliseProcessingSchedule({ idleMinutes: -5 }).idleMinutes).toBe(15);
    expect(normaliseProcessingSchedule({ idleMinutes: 0 }).idleMinutes).toBe(15);
    expect(normaliseProcessingSchedule({ overnightStart: '9pm' }).overnightStart).toBe('22:00');
  });

  it('floors a fractional idleMinutes rather than rejecting it', () => {
    expect(normaliseProcessingSchedule({ idleMinutes: 12.9 }).idleMinutes).toBe(12);
  });

  it('falls back entirely for a non-object value', () => {
    expect(normaliseProcessingSchedule(null)).toEqual({
      mode: 'immediate', idleMinutes: 15, overnightStart: '22:00', overnightEnd: '06:00',
    });
  });
});
