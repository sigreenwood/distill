import { describe, expect, it } from 'vitest';
import { resolveInboxDrop } from '../src/renderer/inbox/importFiles.js';

describe('inbox file drops', () => {
  it('batches calendar PDFs separately from recordings and transcripts in a mixed drop', () => {
    const files = ['October.pdf', 'call.mp3', 'September.PDF', 'notes.md', 'video.mp4', 'notes.txt'];
    const result = resolveInboxDrop(files.map((name) => ({ name })), (file) => `/Users/example/${file.name}`);
    expect(result).toEqual({
      calendarPaths: ['/Users/example/October.pdf', '/Users/example/September.PDF'],
      recordingPaths: ['/Users/example/call.mp3', '/Users/example/notes.md', '/Users/example/video.mp4', '/Users/example/notes.txt'],
      unresolvedNames: [],
    });
  });

  it('reports unresolved files while preserving the rest of the drop and removing duplicates', () => {
    const files = [
      { name: 'calendar.pdf', path: '' },
      { name: 'calendar.PDF', path: '/tmp/calendar.PDF' },
      { name: 'calendar.PDF', path: '/tmp/calendar.PDF' },
      { name: 'audio.wav', path: '/tmp/audio.wav' },
      { name: 'audio.wav', path: '/tmp/audio.wav' },
    ];
    expect(resolveInboxDrop(files, (file) => file.path)).toEqual({
      calendarPaths: ['/tmp/calendar.PDF'],
      recordingPaths: ['/tmp/audio.wav'],
      unresolvedNames: ['calendar.pdf'],
    });
  });
});
