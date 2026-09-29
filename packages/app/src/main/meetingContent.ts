import type { SearchScope } from '../shared/search.js';

export function markdownContent(markdown: string, scope: SearchScope): string | null {
  // Distill exports wrap the two sources in dedicated sections.
  const summary = /^## Summary\s*$/m.exec(markdown);
  const transcript = /^## Transcript\s*$/m.exec(markdown);
  if (scope === 'transcript') return transcript ? markdown.slice(transcript.index + transcript[0].length).trim() : null;
  if (!summary) return null;
  return markdown.slice(summary.index + summary[0].length, transcript?.index)
    .replace(/\n---\s*$/, '').trim();
}
