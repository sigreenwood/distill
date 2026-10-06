import { describe, expect, it } from 'vitest';
import { computeTrayState, tintBgra, TINTED_STATES } from '../src/main/tray.js';

const base = { processingRunning: false, paused: false, errorCount: 0, waitingCount: 0 };

describe('computeTrayState', () => {
  it('ranks error, then attention, then the quiet states', () => {
    expect(computeTrayState({ ...base, errorCount: 1, attention: true })).toBe('error');
    expect(computeTrayState({ ...base, attention: true, processingRunning: true, waitingCount: 3 })).toBe('attention');
    expect(computeTrayState({ ...base, paused: true })).toBe('paused');
    expect(computeTrayState({ ...base, processingRunning: true })).toBe('active');
    expect(computeTrayState({ ...base, waitingCount: 2 })).toBe('waiting');
    expect(computeTrayState(base)).toBe('idle');
  });

  it('colours only the states that need the user', () => {
    expect(Object.keys(TINTED_STATES).sort()).toEqual(['attention', 'error']);
  });
});

describe('tintBgra', () => {
  it('recolours a black template glyph, keeping its alpha (premultiplied BGRA)', () => {
    // Two pixels: opaque black, half-transparent black.
    const out = tintBgra(new Uint8Array([0, 0, 0, 255, 0, 0, 0, 128]), [0xef, 0x44, 0x44]);
    expect([...out.subarray(0, 4)]).toEqual([0x44, 0x44, 0xef, 255]);
    expect([...out.subarray(4, 8)]).toEqual([34, 34, 120, 128]);
  });
});
