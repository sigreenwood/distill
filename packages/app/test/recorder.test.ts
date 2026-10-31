import { describe, it, expect } from 'vitest';
import { parseCaptureEvent, NoSignalWatch, buildMixArgs, callFilename } from '../src/main/recorder.js';

describe('parseCaptureEvent', () => {
  it('parses the helper events', () => {
    expect(parseCaptureEvent('{"event":"ready","mic":true,"tapRate":48000}')).toEqual({ event: 'ready', mic: true });
    expect(parseCaptureEvent('{"event":"level","system":0.2,"mic":0}')).toEqual({ event: 'level', system: 0.2, mic: 0 });
    expect(parseCaptureEvent('{"event":"error","message":"nope"}')).toEqual({ event: 'error', message: 'nope' });
    expect(parseCaptureEvent('{"event":"stopped"}')).toEqual({ event: 'stopped' });
  });

  it('ignores anything else', () => {
    expect(parseCaptureEvent('not json')).toBeNull();
    expect(parseCaptureEvent('{"event":"mystery"}')).toBeNull();
    expect(parseCaptureEvent('{"event":"error"}')).toBeNull();
    expect(parseCaptureEvent('42')).toBeNull();
  });
});

describe('NoSignalWatch', () => {
  it('warns once after the silent window', () => {
    const w = new NoSignalWatch(3);
    expect([w.feed(0), w.feed(0), w.feed(0), w.feed(0)]).toEqual([false, false, true, false]);
  });

  it('never warns once audio has been heard', () => {
    const w = new NoSignalWatch(3);
    w.feed(0);
    w.feed(0.1);
    expect([w.feed(0), w.feed(0), w.feed(0), w.feed(0)]).toEqual([false, false, false, false]);
  });
});

describe('buildMixArgs / callFilename', () => {
  it('mixes both inputs to the output path', () => {
    const a = buildMixArgs('s.wav', 'm.wav', 'out.mp3');
    expect(a.slice(a.indexOf('-i'), a.indexOf('-i') + 2)).toEqual(['-i', 's.wav']);
    expect(a).toContain('m.wav');
    expect(a[a.length - 1]).toBe('out.mp3');
  });

  it('names the file in local time without colons', () => {
    expect(callFilename(new Date(2026, 9, 31, 9, 5))).toBe('Call 2026-10-31 09-05.mp3');
  });
});
