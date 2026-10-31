import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  trackPaths,
  existingTracks,
  removeTracks,
  adoptTracks,
  transcribeInputArgs,
  hasSpeakerLabels,
  speakerLegend,
} from '../src/main/callTracks.js';

describe('trackPaths', () => {
  it('derives sidecars from the audio path by convention', () => {
    expect(trackPaths('/a/b/local-ab12.mp3')).toEqual({
      mic: '/a/b/local-ab12.mic.mp3',
      others: '/a/b/local-ab12.others.mp3',
    });
  });

  it('only strips the final extension and ignores dots in directories', () => {
    expect(trackPaths('/x.y/call.v2.mp3').mic).toBe('/x.y/call.v2.mic.mp3');
  });
});

describe('transcribeInputArgs', () => {
  it('uses the single file when there are no tracks', () => {
    expect(transcribeInputArgs('/a/x.mp3', null)).toEqual(['--audio', '/a/x.mp3']);
  });

  it('points --audio at the others track and --mic-audio at the mic', () => {
    expect(transcribeInputArgs('/a/x.mp3', trackPaths('/a/x.mp3'))).toEqual([
      '--audio', '/a/x.others.mp3', '--mic-audio', '/a/x.mic.mp3',
    ]);
  });
});

describe('speaker labels', () => {
  it('detects a labelled transcript only at the start', () => {
    expect(hasSpeakerLabels('Others: hello\n\nYou: hi')).toBe(true);
    expect(hasSpeakerLabels('You: hi')).toBe(true);
    expect(hasSpeakerLabels('Hello there.\n\nYou: said the narrator')).toBe(false);
    expect(hasSpeakerLabels('Youth: no')).toBe(false);
  });

  it('only gives the summariser a legend for labelled transcripts', () => {
    expect(speakerLegend('Plain paragraph.')).toBeNull();
    expect(speakerLegend('Others: hi')).toMatch(/"Others" is every other participant/);
  });
});

describe('on-disk tracks', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracks-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const touch = (p: string) => fs.writeFileSync(p, 'x');

  it('needs both tracks to count', () => {
    const audio = path.join(tmp, 'local-1.mp3');
    const t = trackPaths(audio);
    expect(existingTracks(audio)).toBeNull();
    touch(t.mic);
    expect(existingTracks(audio)).toBeNull();
    touch(t.others);
    expect(existingTracks(audio)).toEqual(t);
  });

  it('removeTracks deletes the sidecars but never the audio, and tolerates absence', () => {
    const audio = path.join(tmp, 'local-2.mp3');
    const t = trackPaths(audio);
    touch(audio);
    touch(t.mic);
    expect(removeTracks(audio)).toEqual([t.mic]);
    expect(fs.existsSync(audio)).toBe(true);
    expect(removeTracks(audio)).toEqual([]);
  });

  it('adoptTracks moves the tracks next to the imported audio', () => {
    const scratch = path.join(tmp, 'scratch');
    fs.mkdirSync(scratch);
    const from = { mic: path.join(scratch, 'mic.mp3'), others: path.join(scratch, 'others.mp3') };
    touch(from.mic);
    touch(from.others);
    const audio = path.join(tmp, 'local-3.mp3');
    const to = adoptTracks(audio, from);
    expect(fs.existsSync(to.mic) && fs.existsSync(to.others)).toBe(true);
    expect(fs.existsSync(from.mic)).toBe(false);
  });
});
