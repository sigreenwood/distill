import { describe, it, expect } from 'vitest';
import { parseVocabularyMarkdownTables } from '../src/main/vocabularyMarkdownParser.js';

/**
 * Tests for the markdown-table vocabulary parser used by the
 * vocabulary import IPC handler when a user picks a .md / .markdown
 * file. The parser walks GitHub-flavoured-markdown tables looking
 * for the "Heard as / Should be / Context cue" header shape and
 * extracts replacement rules; tables with other shapes are skipped.
 */

describe('parseVocabularyMarkdownTables', () => {
  it('extracts a single replacement from a basic three-column table', () => {
    const md = [
      '# My vocab',
      '',
      '| Heard as | Should be | Context cue |',
      '|---|---|---|',
      '| akmee | Acme | |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ from: 'akmee', to: 'Acme' });
  });

  it('extracts the context cue split on commas, trimmed', () => {
    const md = [
      '| Heard as | Should be | Context cue |',
      '|---|---|---|',
      '| sim | CIM | marketing,  campaign , customer |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      from: 'sim',
      to: 'CIM',
      requiresContext: ['marketing', 'campaign', 'customer'],
    });
  });

  it('omits requiresContext when the cell is empty', () => {
    const md = [
      '| Heard as | Should be | Context cue |',
      '|---|---|---|',
      '| akmee | Acme | |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows[0]).not.toHaveProperty('requiresContext');
  });

  it('omits requiresContext when the third column is missing entirely', () => {
    // Header has only two columns; parser still recognises it as a
    // vocabulary table and emits replacements without context.
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      '| akmee | Acme |',
      '| fall come | Falcon |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ from: 'akmee', to: 'Acme' });
    expect(rows[1]).toEqual({ from: 'fall come', to: 'Falcon' });
  });

  it('parses multiple tables in one file and concatenates their rows', () => {
    const md = [
      '## Section A',
      '',
      '| Heard as | Should be |',
      '|---|---|',
      '| a | A |',
      '',
      '## Section B',
      '',
      '| Heard as | Should be | Context cue |',
      '|---|---|---|',
      '| b | B | foo |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.from).toBe('a');
    expect(rows[1]).toEqual({ from: 'b', to: 'B', requiresContext: ['foo'] });
  });

  it('skips tables whose headers do not match (e.g. acronym glossaries)', () => {
    // The Teradata-style glossary header is intentionally NOT
    // recognised — its columns are "Acronym | Expansion" which is a
    // different concept (acronym lookup, not from→to replacement).
    // We accept the file but only extract from the vocabulary
    // tables it contains.
    const md = [
      '## Acronyms',
      '',
      '| Acronym | Expansion | Notes | Conf. |',
      '|---|---|---|---|',
      '| AMP | Access Module Processor | virtual processor | [V] |',
      '| PE | Parsing Engine | dispatches SQL | [V] |',
      '',
      '## Mistranscriptions',
      '',
      '| Heard as | Should be | Context cue |',
      '|---|---|---|',
      '| akmee | Acme | |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from).toBe('akmee');
  });

  it('is case-insensitive on header column names', () => {
    const md = [
      '| HEARD AS | should be | Context Cue |',
      '|---|---|---|',
      '| akmee | Acme | |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
  });

  it('drops body rows where either key cell is empty after trim', () => {
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      '|   | Acme |',
      '| akmee |   |',
      '|   |   |',
      '| valid | row |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    // Only the last row has both cells populated.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from).toBe('valid');
  });

  it('tolerates rows with and without leading / trailing pipes', () => {
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      'akmee | Acme',
      '| akmee2 | Acme2 |',
      'akmee3 | Acme3 |',
      '| akmee4 | Acme4',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.from)).toEqual([
      'akmee',
      'akmee2',
      'akmee3',
      'akmee4',
    ]);
  });

  it('handles GFM separator rows with alignment colons', () => {
    const md = [
      '| Heard as | Should be | Context cue |',
      '|:---:|:---|---:|',
      '| akmee | Acme | |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
  });

  it('returns an empty array when no recognised table is present', () => {
    const md =
      '# Just a doc\n\nNo tables here, just prose and a list:\n- one\n- two\n';
    expect(parseVocabularyMarkdownTables(md)).toEqual([]);
  });

  it('returns an empty array on completely empty input', () => {
    expect(parseVocabularyMarkdownTables('')).toEqual([]);
  });

  it('does not bleed across two adjacent tables of different shapes', () => {
    // First table is a vocabulary table; second is a glossary. The
    // glossary's body rows should not be picked up after the
    // vocabulary table closes.
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      '| akmee | Acme |',
      '',
      '| Acronym | Expansion |',
      '|---|---|',
      '| AMP | Access Module Processor |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from).toBe('akmee');
  });

  it('preserves the case of the from / to cells (not lowercased)', () => {
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      '| akmee | Acme Corp |',
      '',
    ].join('\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows[0]!.from).toBe('akmee');
    expect(rows[0]!.to).toBe('Acme Corp');
  });

  it('survives Windows-style CRLF line endings', () => {
    // Authors who edit the file on a Windows machine or paste from
    // Notepad may produce CRLF line endings; the parser must not
    // choke. The split on /\r?\n/ in the implementation handles this.
    const md = [
      '| Heard as | Should be |',
      '|---|---|',
      '| akmee | Acme |',
      '',
    ].join('\r\n');

    const rows = parseVocabularyMarkdownTables(md);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.from).toBe('akmee');
  });
});
