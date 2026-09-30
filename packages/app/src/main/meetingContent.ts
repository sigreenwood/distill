import fs from 'node:fs/promises';
import type { JoinedRecordingRow } from './state.js';
import type { SearchScope } from '../shared/search.js';
import type { MeetingDetail, MeetingText } from '../shared/meeting.js';

export function markdownContent(markdown: string, scope: SearchScope): string | null {
  // Distill exports wrap the two sources in dedicated sections.
  const summary = /^## Summary\s*$/m.exec(markdown);
  const transcript = /^## Transcript\s*$/m.exec(markdown);
  if (scope === 'transcript') return transcript ? markdown.slice(transcript.index + transcript[0].length).trim() : null;
  if (!summary) return null;
  return markdown.slice(summary.index + summary[0].length, transcript?.index)
    .replace(/\n---\s*$/, '').trim();
}

export async function loadMeetingDetail(row: JoinedRecordingRow): Promise<MeetingDetail> {
  const fromDatabase = (text: string | null): MeetingText | null =>
    text?.trim() ? { text, source: 'database' } : null;
  let summary = fromDatabase(row.summary_text);
  let transcript = fromDatabase(row.transcript_text);
  let warning: string | null = null;
  if ((!summary || !transcript) && row.markdown_path) {
    try {
      const markdown = await fs.readFile(row.markdown_path, 'utf8');
      const fromMarkdown = (scope: SearchScope): MeetingText | null => {
        const text = markdownContent(markdown, scope);
        return text ? { text, source: 'markdown' } : null;
      };
      summary ??= fromMarkdown('summary');
      transcript ??= fromMarkdown('transcript');
    } catch {
      warning = 'The saved Markdown could not be read. Any text stored on this Mac is shown below.';
    }
  }
  return {
    id: row.id, title: row.filename, date: row.start_time ?? row.synced_at,
    durationSeconds: row.duration_seconds, client: row.client_name, meetingType: row.meeting_type_name,
    summary, transcript, warning, truncationWarning: row.truncation_warning === 1,
    canReveal: Boolean(row.markdown_path || row.html_path || row.apple_note_id),
  };
}
