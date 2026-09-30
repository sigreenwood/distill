import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadMeetingDetail } from '../src/main/meetingContent.js';
import type { JoinedRecordingRow } from '../src/main/state.js';

const row = {
  id: 'meeting', filename: 'Planning', synced_at: 1234, start_time: null,
  duration_seconds: 120, client_name: 'Example client', meeting_type_name: 'Review',
  summary_text: 'Stored summary', transcript_text: 'Stored transcript',
  truncation_warning: 1, markdown_path: null, html_path: null, apple_note_id: null,
} as JoinedRecordingRow;
let directory: string | undefined;
afterEach(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }); directory = undefined; });

describe('meeting reader content', () => {
  it('reads local text without requiring an export and retains the coverage warning', async () => {
    const result = await loadMeetingDetail(row);
    expect(result.summary).toEqual({ text: 'Stored summary', source: 'database' });
    expect(result.transcript).toEqual({ text: 'Stored transcript', source: 'database' });
    expect(result.date).toBe(1234);
    expect(result.truncationWarning).toBe(true);
    expect(result.canReveal).toBe(false);
  });

  it('fills only missing text from Markdown without replacing the stored source', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-reader-'));
    const file = path.join(directory, 'meeting.md');
    await fs.writeFile(file, '## Summary\nExported summary\n\n---\n\n## Transcript\nExported transcript');
    const result = await loadMeetingDetail({ ...row, transcript_text: null, markdown_path: file });
    expect(result.summary?.text).toBe('Stored summary');
    expect(result.transcript).toEqual({ text: 'Exported transcript', source: 'markdown' });
    expect(result.warning).toBeNull();
    const external = await loadMeetingDetail({ ...row, summary_text: null, transcript_text: null, markdown_path: file });
    expect(external.summary).toEqual({ text: 'Exported summary', source: 'markdown' });
  });

  it('keeps missing transcripts explicit rather than showing the summary as a transcript', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-reader-'));
    const file = path.join(directory, 'meeting.md');
    await fs.writeFile(file, '## Summary\nOnly a summary.');
    const result = await loadMeetingDetail({ ...row, summary_text: null, transcript_text: '  ', markdown_path: file });
    expect(result.summary?.text).toBe('Only a summary.');
    expect(result.transcript).toBeNull();
  });

  it('keeps available text readable if a known export has disappeared', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-reader-'));
    const result = await loadMeetingDetail({ ...row, transcript_text: null, markdown_path: path.join(directory, 'missing.md') });
    expect(result.summary?.text).toBe('Stored summary');
    expect(result.transcript).toBeNull();
    expect(result.warning).toContain('could not be read');
  });
});
