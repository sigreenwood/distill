import { describe, it, expect } from 'vitest';
import { computeTrayState } from '../src/main/trayState.js';

describe('computeTrayState', () => {
  it('returns idle when nothing is happening', () => {
    expect(
      computeTrayState({ processingRunning: false, paused: false, errorCount: 0 }),
    ).toBe('idle');
  });

  it('returns processing when the pipeline is running', () => {
    expect(
      computeTrayState({ processingRunning: true, paused: false, errorCount: 0 }),
    ).toBe('processing');
  });

  it('returns paused when paused and not running', () => {
    expect(
      computeTrayState({ processingRunning: false, paused: true, errorCount: 0 }),
    ).toBe('paused');
  });

  it('returns error when only errors are present', () => {
    expect(
      computeTrayState({ processingRunning: false, paused: false, errorCount: 3 }),
    ).toBe('error');
  });

  it('processing beats paused', () => {
    // Pause affects the poller and the worker-between-recordings, but if
    // something is actively running the user should see green.
    expect(
      computeTrayState({ processingRunning: true, paused: true, errorCount: 0 }),
    ).toBe('processing');
  });

  it('processing beats error', () => {
    // A stale error shouldn't drown out the fact that things are moving.
    expect(
      computeTrayState({ processingRunning: true, paused: false, errorCount: 5 }),
    ).toBe('processing');
  });

  it('paused beats error', () => {
    // If the user has explicitly paused, amber (intentional) wins over
    // red (stale error). The ⚠ glyph still surfaces the error count.
    expect(
      computeTrayState({ processingRunning: false, paused: true, errorCount: 2 }),
    ).toBe('paused');
  });

  it('processing beats both paused and error', () => {
    expect(
      computeTrayState({ processingRunning: true, paused: true, errorCount: 7 }),
    ).toBe('processing');
  });
});
