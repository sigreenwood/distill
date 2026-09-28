/**
 * Markdown-table parser for bulk-importing vocabulary replacement rules.
 *
 * Accepts a markdown file containing one or more GitHub-flavoured-markdown
 * tables in the "Heard as / Should be / Context cue" shape, and returns
 * a list of replacement rules in the same shape used by the JSON
 * vocabulary files.
 *
 * Why this exists:
 *   The maintainer's personal vocabulary lives in a hand-edited
 *   markdown file (private/MY-VOCAB.md) because grouping rules under
 *   prose section headings is much friendlier to author and review
 *   than editing JSON. The Settings → Vocabulary editor's JSON import
 *   path covers programmatic / LLM-generated vocab files; this parser
 *   covers the human-authored markdown shape.
 *
 * Expected shape:
 *   - Tables are GFM-style: pipes `|` separate columns; a separator row
 *     of dashes `|---|---|` follows the header.
 *   - The header row must contain three recognisable column names
 *     (case-insensitive, whitespace-tolerant): "Heard as", "Should be",
 *     and "Context cue". Extra columns to the right of those three are
 *     ignored. Tables whose headers don't match all three names are
 *     silently skipped — lets users mix narrative tables (acronym
 *     glossaries, etc.) into the same file without polluting the
 *     vocabulary import.
 *   - Each data row produces one replacement: col 1 → `from`, col 2 →
 *     `to`, col 3 (if non-empty) → `requiresContext` (split on commas,
 *     trimmed, empty entries dropped).
 *
 * What the parser deliberately does NOT do:
 *   - Read the "Acronym | Expansion | Notes | Conf." shape used by
 *     glossaries like the Teradata acronym table. That format isn't
 *     a clean from→to mapping (the speaker says "AMP", you want "AMP",
 *     not "Access Module Processor") so it's a poor fit for
 *     replacements. Glossary content can still live in the same
 *     markdown file — its tables will simply be skipped on import.
 *   - Generate `whisperHints`. Hints are conceptually different
 *     (Whisper-time bias, not post-pass replacement) and require
 *     different curation. The renderer's JSON path handles them.
 */

/**
 * One replacement rule extracted from a vocabulary markdown table.
 * Mirrors the on-disk shape used by `VocabularyReplacement` in
 * `vocabulary.ts` so callers can pass these straight into
 * `mergeReplacements` without an adapter.
 */
export interface ParsedVocabularyReplacement {
  from: string;
  to: string;
  /**
   * Present iff the source row had a non-empty Context cue cell.
   * Each cell is split on commas; entries are trimmed and empties
   * dropped. Absent (rather than empty array) when the cell was
   * blank, matching the on-disk shape.
   */
  requiresContext?: string[];
}

/**
 * Parse a markdown file and return every replacement rule found in
 * "Heard as / Should be / Context cue" tables. Tables with other
 * column shapes are silently skipped.
 *
 * Pure: no I/O, no logging. The IPC handler decides what to do with
 * an empty result (typically: error with a friendly message pointing
 * at the expected format).
 *
 * Implementation notes:
 *   - We don't pull in a full markdown library. The parser is
 *     line-oriented and only understands GFM tables — anything else
 *     (headings, paragraphs, code fences) is ignored as it walks the
 *     file looking for table starts.
 *   - A table starts when we see two consecutive non-empty pipe-rows
 *     where the second is a separator row (only `-`, `:`, ` `, `|`
 *     characters between the pipes). The first row is the header.
 *   - Once inside a table, we keep reading rows until we hit a
 *     non-pipe line — at which point we close the table and resume
 *     scanning.
 *   - Pipe-escaping (`\|`) inside cells is NOT supported because the
 *     vocabulary use case never needs literal pipes. If that ever
 *     comes up, swap the splitter for one that respects backslash
 *     escapes.
 */
export function parseVocabularyMarkdownTables(
  md: string,
): ParsedVocabularyReplacement[] {
  const out: ParsedVocabularyReplacement[] = [];
  const lines = md.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';

    // A table opens when the current line looks like a table row
    // AND the next line looks like a separator. Otherwise advance.
    if (looksLikeTableRow(line) && looksLikeSeparator(next)) {
      const headerCells = splitTableRow(line);
      const headerMap = recogniseHeader(headerCells);

      // Header didn't match the expected three columns. Walk past
      // the table (until we hit a non-pipe line) so we don't try
      // to parse its body. This is what makes the parser tolerant
      // of mixed-content files: glossary tables pass through
      // untouched.
      if (headerMap === null) {
        i += 2; // skip header + separator
        while (i < lines.length && looksLikeTableRow(lines[i] ?? '')) i++;
        continue;
      }

      // Header is recognised. Read body rows until the table ends.
      i += 2; // past header + separator
      while (i < lines.length && looksLikeTableRow(lines[i] ?? '')) {
        const cells = splitTableRow(lines[i] ?? '');
        const entry = rowToReplacement(cells, headerMap);
        if (entry) out.push(entry);
        i++;
      }
      continue;
    }

    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Does this line look like a table row? GFM tables require at least
 * one pipe; we also tolerate leading/trailing whitespace. A line that
 * is only whitespace or empty is not a table row. We deliberately
 * accept lines without leading/trailing pipes (e.g. `a | b | c`)
 * because GFM allows them — splitTableRow handles both shapes.
 */
function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return trimmed.includes('|');
}

/**
 * Does this line look like a GFM table separator? The separator row
 * sits between the header and body and consists only of dashes
 * (with optional leading colons for alignment), pipes, and
 * whitespace. Example: `|---|:---:|---|`.
 *
 * We check character-by-character rather than via regex because the
 * grammar is small and a regex would obscure intent. Returns false
 * for the empty/whitespace string too — those would be ambiguous.
 */
function looksLikeSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  // Must contain at least one dash (otherwise it's a regular row).
  if (!trimmed.includes('-')) return false;
  for (const ch of trimmed) {
    if (ch !== '-' && ch !== '|' && ch !== ':' && ch !== ' ') return false;
  }
  return true;
}

/**
 * Split a GFM table row into its cells. Tolerates rows with or
 * without leading / trailing pipes:
 *
 *     | a | b | c |     →  ['a', 'b', 'c']
 *     a | b | c          →  ['a', 'b', 'c']
 *     | a | b |          →  ['a', 'b']
 *
 * Cells are trimmed individually. A row with a trailing pipe drops
 * the implied empty cell after it; that matches author intent (the
 * trailing pipe is syntax, not a column).
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  // Drop leading and trailing pipes if present so split doesn't
  // produce phantom empty cells at the edges.
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

/**
 * The columns we care about, by index in the header row. Returned
 * by recogniseHeader so the body-row reader knows where to look.
 *
 * `context` is optional — a table with just "Heard as" and "Should
 * be" columns is also accepted. Tables without those two columns
 * are not.
 */
interface HeaderMap {
  heardAs: number;
  shouldBe: number;
  context: number | null;
}

/**
 * Inspect the header cells and decide whether this is a vocabulary
 * table. Matching is case-insensitive and tolerant of variations
 * like "Heard As" vs "heard as". Returns null when the table isn't
 * a vocabulary one — caller should skip it.
 *
 * "Context cue" / "context" are both accepted for the third column
 * since real authors shorten it sometimes.
 */
function recogniseHeader(cells: string[]): HeaderMap | null {
  let heardAs = -1;
  let shouldBe = -1;
  let context: number | null = null;

  for (let i = 0; i < cells.length; i++) {
    const normalised = cells[i]!.toLowerCase().trim();
    if (heardAs === -1 && normalised === 'heard as') heardAs = i;
    else if (shouldBe === -1 && normalised === 'should be') shouldBe = i;
    else if (
      context === null &&
      (normalised === 'context cue' ||
        normalised === 'context' ||
        normalised === 'context cues')
    ) {
      context = i;
    }
  }

  if (heardAs === -1 || shouldBe === -1) return null;
  return { heardAs, shouldBe, context };
}

/**
 * Convert one body row into a replacement, or null if the row is
 * unusable (both key cells empty / either key cell empty after
 * trim). Single-cell-empty rows are dropped silently rather than
 * thrown — markdown tables often have blank padding rows when
 * authors are mid-edit, and surfacing those as parse errors would
 * be hostile.
 *
 * Context cue is split on commas; whitespace-only entries are
 * dropped. If every entry was empty (e.g. a single comma in an
 * otherwise blank cell), we omit `requiresContext` entirely rather
 * than emitting an empty array — the on-disk shape uses
 * presence/absence, not empty/non-empty.
 */
function rowToReplacement(
  cells: string[],
  header: HeaderMap,
): ParsedVocabularyReplacement | null {
  const from = (cells[header.heardAs] ?? '').trim();
  const to = (cells[header.shouldBe] ?? '').trim();
  if (from.length === 0 || to.length === 0) return null;

  let requiresContext: string[] | undefined;
  if (header.context !== null) {
    const raw = (cells[header.context] ?? '').trim();
    if (raw.length > 0) {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length > 0) requiresContext = parts;
    }
  }

  return {
    from,
    to,
    ...(requiresContext ? { requiresContext } : {}),
  };
}
