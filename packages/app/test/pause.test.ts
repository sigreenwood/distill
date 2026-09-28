import { describe, it, expect } from 'vitest';
import {
  defaultPauseConfig,
  formatPauseStatus,
  normalisePause,
  pausedSteps,
  shouldRunStep,
  type PauseConfig,
} from '../src/main/pause.js';

describe('normalisePause', () => {
  it('treats undefined as nothing paused', () => {
    expect(normalisePause(undefined)).toEqual(defaultPauseConfig());
  });

  it('treats null as nothing paused', () => {
    expect(normalisePause(null)).toEqual(defaultPauseConfig());
  });

  it('treats legacy `paused: true` as master switch on', () => {
    // Back-compat per BACKLOG. Older configs predate the per-step shape;
    // a `true` there meant "pause everything", which is exactly what the
    // master switch now expresses.
    expect(normalisePause(true)).toEqual({
      all: true,
      polling: false,
      download: false,
      transcribe: false,
      summarise: false,
    });
  });

  it('treats legacy `paused: false` as nothing paused', () => {
    expect(normalisePause(false)).toEqual(defaultPauseConfig());
  });

  it('reads object form field-by-field', () => {
    expect(
      normalisePause({
        all: false,
        polling: true,
        download: false,
        transcribe: true,
        summarise: false,
      }),
    ).toEqual({
      all: false,
      polling: true,
      download: false,
      transcribe: true,
      summarise: false,
    });
  });

  it('defaults missing object fields to false', () => {
    // Hand-edited config might only set the fields the user cares about.
    expect(normalisePause({ download: true })).toEqual({
      all: false,
      polling: false,
      download: true,
      transcribe: false,
      summarise: false,
    });
  });

  it('drops unknown object fields silently', () => {
    // Tolerance over strictness for hand-edited config; a typo
    // shouldn't blow up the app on startup.
    expect(normalisePause({ download: true, garbage: 'wat' })).toEqual({
      all: false,
      polling: false,
      download: true,
      transcribe: false,
      summarise: false,
    });
  });

  it('treats arrays as nothing paused', () => {
    // Arrays are objects in JS but clearly not the intended shape.
    expect(normalisePause(['polling', 'download'])).toEqual(defaultPauseConfig());
  });

  it('treats non-boolean field values as false', () => {
    // `"true"` (string) is not the same as `true`; strictly read booleans.
    expect(normalisePause({ download: 'true', transcribe: 1 })).toEqual(
      defaultPauseConfig(),
    );
  });
});

describe('shouldRunStep', () => {
  const cfg = (overrides: Partial<PauseConfig> = {}): PauseConfig => ({
    ...defaultPauseConfig(),
    ...overrides,
  });

  it('runs every step when nothing is paused', () => {
    const c = cfg();
    expect(shouldRunStep(c, 'polling')).toBe(true);
    expect(shouldRunStep(c, 'download')).toBe(true);
    expect(shouldRunStep(c, 'transcribe')).toBe(true);
    expect(shouldRunStep(c, 'summarise')).toBe(true);
  });

  it('master overrides every per-step flag', () => {
    // When `all` is on, individual flags don't matter; every step is paused.
    // This matters for the tray submenu's "All processing" item.
    const c = cfg({ all: true, download: false, transcribe: false });
    expect(shouldRunStep(c, 'polling')).toBe(false);
    expect(shouldRunStep(c, 'download')).toBe(false);
    expect(shouldRunStep(c, 'transcribe')).toBe(false);
    expect(shouldRunStep(c, 'summarise')).toBe(false);
  });

  it('per-step flag pauses only that step', () => {
    const c = cfg({ download: true });
    expect(shouldRunStep(c, 'download')).toBe(false);
    expect(shouldRunStep(c, 'transcribe')).toBe(true);
    expect(shouldRunStep(c, 'summarise')).toBe(true);
    expect(shouldRunStep(c, 'polling')).toBe(true);
  });
});

describe('pausedSteps', () => {
  const cfg = (overrides: Partial<PauseConfig> = {}): PauseConfig => ({
    ...defaultPauseConfig(),
    ...overrides,
  });

  it('returns empty array when nothing paused', () => {
    expect(pausedSteps(cfg())).toEqual([]);
  });

  it('returns full canonical list when master is on', () => {
    // Master overrides per-step flags. The tray should reflect "everything
    // is paused" rather than "only what was individually flagged".
    expect(pausedSteps(cfg({ all: true }))).toEqual([
      'polling',
      'download',
      'transcribe',
      'summarise',
    ]);
  });

  it('returns just the flagged steps in canonical order', () => {
    // Order is canonical (polling, download, transcribe, summarise) regardless
    // of insertion order. The status line and submenu both rely on stability.
    expect(
      pausedSteps(cfg({ summarise: true, download: true })),
    ).toEqual(['download', 'summarise']);
  });
});

describe('formatPauseStatus', () => {
  const cfg = (overrides: Partial<PauseConfig> = {}): PauseConfig => ({
    ...defaultPauseConfig(),
    ...overrides,
  });

  it('returns null when nothing is paused', () => {
    // Caller (tray) falls back to "Synced ..." when this returns null.
    expect(formatPauseStatus(cfg())).toBeNull();
  });

  it('returns plain "Paused" when master is on', () => {
    expect(formatPauseStatus(cfg({ all: true }))).toBe('Paused');
  });

  it('master overrides even when per-step flags are also set', () => {
    // The user has master+individual flags both on; show the simpler label
    // because per-step granularity is hidden behind the master switch.
    expect(
      formatPauseStatus(cfg({ all: true, download: true, transcribe: true })),
    ).toBe('Paused');
  });

  it('names a single paused step', () => {
    expect(formatPauseStatus(cfg({ download: true }))).toBe('Paused (downloads)');
  });

  it('lists two paused steps in canonical order', () => {
    // Order matches PAUSABLE_STEPS, not the order flags were set.
    expect(
      formatPauseStatus(cfg({ transcribe: true, polling: true })),
    ).toBe('Paused (polling, transcribe)');
  });

  it('lists three paused steps comma-separated', () => {
    expect(
      formatPauseStatus(cfg({ download: true, transcribe: true, summarise: true })),
    ).toBe('Paused (downloads, transcribe, summarise)');
  });
});
