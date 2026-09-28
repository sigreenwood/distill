/**
 * Shared helpers for building output content.
 *
 * Every output destination needs the same core material: a title, a
 * summary body, optionally a transcript. The Markdown / HTML / Apple
 * Notes writers all derive their format-specific content from this
 * shared representation.
 */

import { join } from 'node:path';

export interface OutputSource {
  id: string;
  filename: string;
  client_name: string | null;
  meeting_type_name: string | null;
  start_time: number | null;
  duration_seconds: number | null;
  model_snapshot: string | null;
  whisper_snapshot: string | null;
  vocabulary_sources: string | null;
  vocabulary_rules_applied: number | null;
  summary_text: string | null;
  transcript_text: string | null;
}

/**
 * Strip characters that cause trouble in macOS filenames, collapse
 * whitespace, trim trailing dots/dashes. Returns a safe filename
 * component that's never empty (falls back to 'untitled').
 */
export function sanitiseForFilename(s: string): string {
  return (
    s
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .trim() || 'untitled'
  );
}

/**
 * Format an epoch ms timestamp as "YYYY-MM-DD HH-MM" for use in a
 * filename. Uses local time because that's what matches how the user
 * thinks about their meetings.
 *
 * Plaud returns `start_time` in epoch milliseconds. Do NOT multiply by
 * 1000 — an earlier version did and produced filenames dated year 57,000.
 */
export function formatDateForFilename(startTimeMs: number | null): string {
  const d = startTimeMs ? new Date(startTimeMs) : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}-${mi}`;
}

/**
 * Extract a short title from the first line of a summary.
 *
 * The four built-in prompts in PROMPTS.md (and any user-edited or
 * user-created prompt that follows the same convention) are instructed
 * to begin their output with a single-line title of 8-10 words. This
 * helper pulls that title back out for the filename.
 *
 * Strategy:
 *   1. Split on newlines, take the first non-empty line.
 *   2. Strip leading markdown noise (`#`, `**`, `_`, blockquote markers,
 *      list bullets) and trailing punctuation.
 *   3. Reject anything that looks like a section header from a prompt
 *      that didn't follow the convention ("Executive Summary",
 *      "Summary", "# 1) ...") - these would make terrible filenames.
 *   4. Truncate to a sensible word count (15 max - we accept summaries
 *      that aren't perfectly 8-10 words).
 *
 * Returns null if no usable title can be extracted; callers fall back
 * to the original Plaud filename in that case.
 */
export function extractTitleFromSummary(summary: string | null): string | null {
  if (!summary) return null;

  // Find first non-empty line.
  const firstLine = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;

  // Reject numbered section openers BEFORE we strip prefixes - the
  // strip step would remove the leading "1) " or "1. " and leave a
  // plausible-looking title behind, which is exactly what we don't
  // want. "1) One-page summary..." is a section opener no matter how
  // it cleans up.
  if (/^\d+[.)]\s/.test(firstLine)) return null;

  // Strip leading markdown structural prefixes:
  //   - `# ` / `## ` / `### ` headings
  //   - `> ` blockquote
  //   - `- ` / `* ` / `1. ` list bullets
  //   - leading bold/italic markers (`**`, `__`, `*`, `_`)
  //   - leading emoji-followed-by-space (✍️ Title, 📁 Folder, etc.)
  let title = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\*\*+|\*\*+$/g, '')
    .replace(/^__+|__+$/g, '')
    .replace(/^[*_]|[*_]$/g, '')
    .trim();

  // Reject bare section-header first lines that escaped a prompt that
  // didn't follow the title convention. The original Plaud filename is
  // a better fallback than "Executive Summary" as a filename.
  const HEADER_PATTERNS = [
    /^executive summary$/i,
    /^summary$/i,
    /^overview$/i,
    /^introduction$/i,
    /^meeting (minutes|notes|summary)$/i,
    /^transcript$/i,
  ];
  for (const pat of HEADER_PATTERNS) {
    if (pat.test(title)) return null;
  }

  // Strip trailing sentence punctuation. A title-shaped line might end
  // with a period; we don't want that in the filename.
  title = title.replace(/[.!?:;,]+$/, '').trim();

  if (title.length === 0) return null;

  // Truncate by word count. Aim for ~10 words, accept up to 15.
  const words = title.split(/\s+/);
  if (words.length > 15) {
    title = words.slice(0, 15).join(' ');
  }

  // Final sanity: reject if shorter than 3 words (probably not an
  // actual title - more likely a fragment from a prompt that didn't
  // follow the convention).
  if (title.split(/\s+/).length < 3) return null;

  return title;
}

/**
 * Compose the filename stem (no extension) that all file outputs share.
 *
 * Format: `{YYYY-MM-DD HH-MM} - {Client} - {Title}`
 *
 * The title comes from the summary's first line when available (see
 * `extractTitleFromSummary`); otherwise falls back to the original
 * Plaud filename. The client segment is included redundantly with the
 * per-client folder structure so that grepping across folders, or
 * sharing a single file out of context, still tells you who it's for.
 *
 * E.g. "2026-04-25 14-30 - Acme Corp - Quarterly review of agentic AI roadmap".
 *
 * Note: filenames generated before this change used em-dash separators
 * and only the Plaud filename. Existing files on disk are not renamed;
 * only newly-written files use this format.
 */
export function buildFilenameStem(row: OutputSource): string {
  const dateStr = formatDateForFilename(row.start_time);
  const client = sanitiseForFilename(row.client_name ?? 'Unclassified');

  const extracted = extractTitleFromSummary(row.summary_text);
  // Cap the title segment at 80 chars after sanitising - long titles
  // hit macOS filesystem limits (255 bytes total) once the date and
  // client are also accounted for. 80 chars leaves comfortable headroom.
  const titleSource = extracted ?? row.filename;
  const title = sanitiseForFilename(titleSource).slice(0, 80);

  return `${dateStr} - ${client} - ${title}`;
}

/**
 * The per-client folder for a recording (just the client name,
 * sanitised for use as a folder name).
 */
export function clientFolderName(row: OutputSource): string {
  return sanitiseForFilename(row.client_name ?? 'Unclassified');
}

/**
 * Absolute target path for a file output. Takes the base dir (already
 * expanded), the extension (e.g. ".md"), and the row. Does not create
 * the directory — the caller should mkdir it before writing.
 */
export function buildFilePath(baseDir: string, extension: string, row: OutputSource): string {
  const dir = join(baseDir, clientFolderName(row));
  const stem = buildFilenameStem(row);
  return join(dir, `${stem}${extension}`);
}

/**
 * Choose an alternate path if the primary already exists. Adds ` (1)`,
 * ` (2)`, etc. to the filename stem until a free name is found.
 * Returns the primary path unchanged if nothing collides.
 *
 * Bounded at 99 attempts; beyond that we give up and return the last
 * tried path so the caller sees an ENOENT or overwrites — preferable to
 * a silent infinite loop.
 */
export function uniquifyPath(
  existsSync: (p: string) => boolean,
  primary: string,
  extension: string,
): string {
  if (!existsSync(primary)) return primary;
  const stem = primary.slice(0, primary.length - extension.length);
  for (let n = 1; n <= 99; n++) {
    const candidate = `${stem} (${n})${extension}`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem} (99)${extension}`;
}
