/**
 * Tests for the filename-stem builder, especially the new
 * `extractTitleFromSummary` helper that pulls a short title out of the
 * first line of a summary for use in the output filename.
 *
 * See `buildFilenameStem` in src/main/outputs/shared.ts for the full
 * format contract these tests pin down.
 */

import { describe, it, expect } from 'vitest';
import {
  buildFilenameStem,
  extractTitleFromSummary,
  type OutputSource,
} from '../src/main/outputs/shared.js';

// A minimal OutputSource for filename tests. Only fields used by
// buildFilenameStem matter; the rest are filled with safe nulls.
function row(overrides: Partial<OutputSource> = {}): OutputSource {
  return {
    id: 'rec-1',
    filename: 'Plaud generated title.mp3',
    client_name: 'Acme Corp',
    meeting_type_name: 'client-call',
    // 2026-04-25 14:30 local. The `start_time` in epoch ms.
    start_time: new Date('2026-04-25T14:30:00').getTime(),
    duration_seconds: 1800,
    model_snapshot: null,
    whisper_snapshot: null,
    vocabulary_sources: null,
    vocabulary_rules_applied: null,
    summary_text: null,
    transcript_text: null,
    ...overrides,
  };
}

describe('extractTitleFromSummary', () => {
  it('returns null for null/empty input', () => {
    expect(extractTitleFromSummary(null)).toBeNull();
    expect(extractTitleFromSummary('')).toBeNull();
    expect(extractTitleFromSummary('   \n\n  ')).toBeNull();
  });

  it('extracts a plain first-line title', () => {
    const summary = `Quarterly review of agentic AI roadmap and next steps

# Executive Summary
The team discussed...`;
    expect(extractTitleFromSummary(summary)).toBe(
      'Quarterly review of agentic AI roadmap and next steps',
    );
  });

  it('strips heading markers', () => {
    expect(
      extractTitleFromSummary('# Quarterly review of agentic AI roadmap and next steps'),
    ).toBe('Quarterly review of agentic AI roadmap and next steps');
    expect(
      extractTitleFromSummary('## Cloud migration architecture decisions and follow-ups'),
    ).toBe('Cloud migration architecture decisions and follow-ups');
  });

  it('strips bold/italic wrappers', () => {
    expect(
      extractTitleFromSummary('**Quarterly review of agentic AI roadmap**'),
    ).toBe('Quarterly review of agentic AI roadmap');
    expect(
      extractTitleFromSummary('_Cloud migration decisions and timelines_'),
    ).toBe('Cloud migration decisions and timelines');
  });

  it('strips trailing sentence punctuation', () => {
    expect(
      extractTitleFromSummary('Quarterly review of agentic AI roadmap.'),
    ).toBe('Quarterly review of agentic AI roadmap');
    expect(
      extractTitleFromSummary('Cloud migration decisions and timelines!'),
    ).toBe('Cloud migration decisions and timelines');
  });

  it('rejects bare section headings', () => {
    // A prompt that didn't follow the title convention - the original
    // Plaud filename is a better fallback than these as filenames.
    expect(extractTitleFromSummary('Executive Summary')).toBeNull();
    expect(extractTitleFromSummary('# Executive Summary')).toBeNull();
    expect(extractTitleFromSummary('Summary')).toBeNull();
    expect(extractTitleFromSummary('Overview')).toBeNull();
    expect(extractTitleFromSummary('Meeting Minutes')).toBeNull();
    expect(extractTitleFromSummary('Meeting Notes')).toBeNull();
    expect(extractTitleFromSummary('Transcript')).toBeNull();
  });

  it('rejects numbered section openings', () => {
    expect(
      extractTitleFromSummary('1) One-page summary of the call follows below'),
    ).toBeNull();
    expect(
      extractTitleFromSummary('1. Apologies for absence and member updates'),
    ).toBeNull();
  });

  it('rejects very short fragments (< 3 words)', () => {
    // "Q3 review" is two words - probably not a real title, more
    // likely a fragment from a prompt that didn't follow the convention.
    expect(extractTitleFromSummary('Q3 review')).toBeNull();
    expect(extractTitleFromSummary('Notes.')).toBeNull();
  });

  it('truncates overlong titles to 15 words', () => {
    const longLine =
      'A very long title that clearly exceeds the suggested ten words and keeps going for many more words past the limit';
    const result = extractTitleFromSummary(longLine);
    expect(result).not.toBeNull();
    expect(result!.split(/\s+/).length).toBe(15);
  });

  it('skips leading blank lines', () => {
    const summary = '\n\n  \n\nQuarterly review of agentic AI roadmap';
    expect(extractTitleFromSummary(summary)).toBe(
      'Quarterly review of agentic AI roadmap',
    );
  });

  it('handles list-bullet first lines', () => {
    expect(
      extractTitleFromSummary('- Quarterly review of agentic AI roadmap'),
    ).toBe('Quarterly review of agentic AI roadmap');
    expect(
      extractTitleFromSummary('* Cloud migration decisions and timelines'),
    ).toBe('Cloud migration decisions and timelines');
  });

  it('handles blockquote first lines', () => {
    expect(
      extractTitleFromSummary('> Quarterly review of agentic AI roadmap'),
    ).toBe('Quarterly review of agentic AI roadmap');
  });
});

describe('buildFilenameStem', () => {
  it('uses extracted title from summary when available', () => {
    const stem = buildFilenameStem(
      row({
        summary_text:
          'Quarterly review of agentic AI roadmap and next steps\n\n# Executive Summary\n...',
      }),
    );
    expect(stem).toBe(
      '2026-04-25 14-30 - Acme Corp - Quarterly review of agentic AI roadmap and next steps',
    );
  });

  it('falls back to Plaud filename when summary has no usable title', () => {
    // Summary starts with a section header that gets rejected.
    const stem = buildFilenameStem(
      row({
        filename: 'Original Plaud title.mp3',
        summary_text: '# Executive Summary\n\nThe team discussed...',
      }),
    );
    expect(stem).toBe('2026-04-25 14-30 - Acme Corp - Original Plaud title.mp3');
  });

  it('falls back to Plaud filename when no summary exists', () => {
    const stem = buildFilenameStem(
      row({
        filename: 'Original Plaud title.mp3',
        summary_text: null,
      }),
    );
    expect(stem).toBe('2026-04-25 14-30 - Acme Corp - Original Plaud title.mp3');
  });

  it('uses Unclassified when client_name is null', () => {
    const stem = buildFilenameStem(
      row({
        client_name: null,
        summary_text: 'Quarterly review of agentic AI roadmap',
      }),
    );
    expect(stem).toBe(
      '2026-04-25 14-30 - Unclassified - Quarterly review of agentic AI roadmap',
    );
  });

  it('caps title segment at 80 chars', () => {
    // Build a 15-word title that exceeds 80 chars.
    const longSummary =
      'Comprehensive enterprise data platform modernisation discussion with multiple stakeholders covering many architectural domains';
    const stem = buildFilenameStem(row({ summary_text: longSummary }));
    // Pull the title segment out of the stem.
    const parts = stem.split(' - ');
    const titleSegment = parts[parts.length - 1]!;
    expect(titleSegment.length).toBeLessThanOrEqual(80);
  });

  it('sanitises filesystem-unsafe characters in client name and title', () => {
    const stem = buildFilenameStem(
      row({
        client_name: 'Acme/Corp',
        summary_text: 'Cloud migration: architecture decisions and timelines',
      }),
    );
    // Slashes turned into hyphens, colons turned into hyphens, then
    // sanitisation collapses any whitespace.
    expect(stem).toContain('Acme-Corp');
    expect(stem).not.toContain('/');
    expect(stem).not.toContain(':');
  });
});
