import { describe, it, expect } from 'vitest';
import { parseTranscriptFile, TranscriptImportError } from '../src/main/transcriptImport.js';
import { nextNeededStep } from '../src/main/state.js';
import type { RecordingRow } from '../src/main/state.js';
import { classifyPath } from '../src/main/localImport.js';

/** A distill Markdown output, in the shape buildMarkdown writes. */
const DISTILL_OUTPUT = `---
recording_id: abc123
filename: "07-27 Meeting: CIM/VCX Operations"
client: "HSBC"
meeting_type: "Client Call (CSA/AE/SEM)"
duration_seconds: 1948
model: "qwen3.5:27b"
whisper_model: "mlx-community/whisper-large-v3-turbo"
transcript_embedded: true
---

# 07-27 Meeting: CIM/VCX Operations

## Summary

The team agreed to migrate in Q4.

---

## Transcript

Alice: shall we start.
Bob: yes, the migration timeline is the main thing.
`;

describe('parseTranscriptFile — distill Markdown', () => {
  it('extracts only the transcript, not the summary', () => {
    const p = parseTranscriptFile(DISTILL_OUTPUT, 'meeting.md');
    expect(p.transcript).toContain('Alice: shall we start.');
    expect(p.transcript).toContain('Bob: yes');
    // The summary must not leak in — re-summarising a summary would
    // quietly compound the model's earlier interpretation.
    expect(p.transcript).not.toContain('The team agreed to migrate');
  });

  it('recovers the original tagging metadata', () => {
    const p = parseTranscriptFile(DISTILL_OUTPUT, 'meeting.md');
    expect(p.clientName).toBe('HSBC');
    expect(p.meetingTypeName).toBe('Client Call (CSA/AE/SEM)');
    expect(p.sourceRecordingId).toBe('abc123');
    expect(p.whisperModel).toBe('mlx-community/whisper-large-v3-turbo');
    expect(p.fromDistillOutput).toBe(true);
  });

  it('takes the title from the H1', () => {
    expect(parseTranscriptFile(DISTILL_OUTPUT, 'meeting.md').title).toBe(
      '07-27 Meeting: CIM/VCX Operations',
    );
  });

  it('explains clearly when the transcript was not embedded', () => {
    const summaryOnly = DISTILL_OUTPUT.replace(/## Transcript[\s\S]*$/, '');
    expect(() => parseTranscriptFile(summaryOnly, 'summary-only.md')).toThrow(
      TranscriptImportError,
    );
    expect(() => parseTranscriptFile(summaryOnly, 'summary-only.md')).toThrow(
      /no Transcript section/i,
    );
  });
});

describe('parseTranscriptFile — plain text', () => {
  it('treats the whole file as the transcript', () => {
    const p = parseTranscriptFile('Just some spoken words.\nAnd more.', 'notes.txt');
    expect(p.transcript).toBe('Just some spoken words.\nAnd more.');
    expect(p.fromDistillOutput).toBe(false);
    expect(p.clientName).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(() => parseTranscriptFile('   \n  ', 'empty.txt')).toThrow(/empty/i);
  });
});

describe('classifyPath', () => {
  it('routes transcripts, audio and video to the right importer', () => {
    expect(classifyPath('/x/a.md')).toBe('transcript');
    expect(classifyPath('/x/a.txt')).toBe('transcript');
    expect(classifyPath('/x/a.mp3')).toBe('audio-passthrough');
    expect(classifyPath('/x/a.mp4')).toBe('video-extract-audio');
    expect(classifyPath('/x/a.pages')).toBe('unsupported');
  });
});

describe('nextNeededStep with an imported transcript', () => {
  const base = {
    audio_path: null,
    transcript_text: null,
    summary_text: null,
  } as unknown as RecordingRow;

  it('starts at summarise when a transcript exists but no audio', () => {
    // Regression: the old order checked audio_path first, so an imported
    // transcript would try to download audio that never existed.
    const row = { ...base, transcript_text: 'some words' } as RecordingRow;
    expect(nextNeededStep(row)).toBe('summarise');
  });

  it('still downloads when there is neither audio nor transcript', () => {
    expect(nextNeededStep(base)).toBe('download');
  });

  it('still transcribes when audio exists but no transcript', () => {
    expect(nextNeededStep({ ...base, audio_path: '/a.mp3' } as RecordingRow)).toBe('transcribe');
  });

  it('writes once a summary exists', () => {
    const row = { ...base, transcript_text: 't', summary_text: 's' } as RecordingRow;
    expect(nextNeededStep(row)).toBe('write');
  });
});
