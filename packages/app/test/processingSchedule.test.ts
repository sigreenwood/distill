import { describe, expect, it } from 'vitest';
import { evaluateSchedule, isWithinOvernightWindow, type ProcessingSchedule } from '../src/main/processingSchedule.js';

const schedule = (patch: Partial<ProcessingSchedule> = {}): ProcessingSchedule => ({
  mode: 'immediate', idleMinutes: 15, overnightStart: '22:00', overnightEnd: '06:00', ...patch,
});
const at = (h: number, m: number) => new Date(2026, 0, 1, h, m);

describe('isWithinOvernightWindow', () => {
  it('handles a same-day window normally', () => {
    expect(isWithinOvernightWindow(at(13, 0), '09:00', '17:00')).toBe(true);
    expect(isWithinOvernightWindow(at(8, 59), '09:00', '17:00')).toBe(false);
    expect(isWithinOvernightWindow(at(17, 0), '09:00', '17:00')).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    expect(isWithinOvernightWindow(at(23, 0), '22:00', '06:00')).toBe(true);
    expect(isWithinOvernightWindow(at(2, 0), '22:00', '06:00')).toBe(true);
    expect(isWithinOvernightWindow(at(12, 0), '22:00', '06:00')).toBe(false);
    expect(isWithinOvernightWindow(at(21, 59), '22:00', '06:00')).toBe(false);
    expect(isWithinOvernightWindow(at(6, 0), '22:00', '06:00')).toBe(false);
  });

  it('treats an unparseable or equal start/end as never in window, rather than throwing', () => {
    expect(isWithinOvernightWindow(at(12, 0), 'bogus', '06:00')).toBe(false);
    expect(isWithinOvernightWindow(at(12, 0), '09:00', '09:00')).toBe(false);
  });
});

describe('evaluateSchedule', () => {
  it('immediate mode is always allowed, regardless of idle time or clock', () => {
    expect(evaluateSchedule(schedule({ mode: 'immediate' }), 0)).toEqual({ allowed: true, reason: null });
  });

  it('idle mode compares system idle seconds against idleMinutes', () => {
    const s = schedule({ mode: 'idle', idleMinutes: 10 });
    expect(evaluateSchedule(s, 599).allowed).toBe(false);
    expect(evaluateSchedule(s, 600).allowed).toBe(true);
    expect(evaluateSchedule(s, 599).reason).toMatch(/idle for 10 minutes/);
  });

  it('overnight mode defers to isWithinOvernightWindow and names the window when blocked', () => {
    const s = schedule({ mode: 'overnight', overnightStart: '22:00', overnightEnd: '06:00' });
    expect(evaluateSchedule(s, 0, at(23, 0))).toEqual({ allowed: true, reason: null });
    const blocked = evaluateSchedule(s, 0, at(12, 0));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('22:00');
    expect(blocked.reason).toContain('06:00');
  });
});
