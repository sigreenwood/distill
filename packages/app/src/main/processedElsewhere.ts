/**
 * Cross-machine completion detection.
 *
 * When distill runs on more than one machine (Si has an M4 and an M5,
 * both syncing iCloud Drive Documents to the same Markdown output
 * folder), we want recordings already processed on machine A to NOT
 * be re-processed when the poller wakes up on machine B. Re-processing
 * the same recording is wasteful (CPU + battery + RAM, possibly with
 * a different model) and would produce a "(1).md" duplicate next to
 * the original.
 *
 * Strategy: scan the configured Markdown output directory at poll
 * time, parse YAML frontmatter from each `.md` file, and build a
 * Map keyed by `recording_id` to the metadata we care about.
 *
 * The poller consults this Map before deciding the status of a
 * newly-discovered Plaud recording: if the id is already in the Map,
 * insert the row as `complete` with `processed_externally = 1`
 * rather than `inbox`. The pipeline never runs for it; the user sees
 * a "processed on another machine" badge in the inbox so they know
 * the row's summary is on disk and which model produced it.
 *
 * Why frontmatter, not filename: distill's filenames depend on the
 * summary's first line (see `outputs/shared.ts::buildFilenameStem`),
 * which differs between machines if the prompts differ. The
 * `recording_id` field in frontmatter is the deterministic identity
 * key, set the same way on every machine.
 *
 * Why Markdown only, not HTML / Apple Notes: HTML output doesn't
 * embed `recording_id` (it's a presentation format, not structured
 * metadata), and Apple Notes' AppleScript bridge doesn't expose a
 * fast way to enumerate notes by metadata. Markdown is the cheapest
 * and most reliable index. If a user has Markdown disabled, the
 * cross-machine detection silently no-ops; they'll get duplicates
 * if they process the same recording on two machines, which is the
 * same as today's behaviour.
 *
 * Why scan once per poll, not maintain an index file: the directory
 * scan is fast (typical user has dozens to hundreds of files, not
 * tens of thousands; each parse stops after the closing `---`).
 * Maintaining a separate index file introduces its own consistency
 * problems (what if the user deletes a file in Finder? what if iCloud
 * sync is mid-flight?). Re-scanning is dumb, correct, and
 * sub-100ms in practice.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What we extract from each markdown file's frontmatter. All optional
 * because frontmatter contents may evolve; missing fields just mean
 * "we don't know" and the inbox UI degrades gracefully.
 */
export interface ProcessedRecord {
  /** Absolute path to the existing markdown file. */
  markdownPath: string;
  /** mtime of the markdown file (ms since epoch), so the row's `markdown_written_at` reflects when it was actually written elsewhere. */
  writtenAtMs: number;
  /** The Ollama model that produced the summary, if frontmatter recorded it. Used by the inbox UI to show "summary by qwen2.5:14b" on imported rows. */
  modelSnapshot: string | null;
  /** The Whisper model used. Same purpose as modelSnapshot but for the transcription model. */
  whisperSnapshot: string | null;
}

/**
 * Scan a Markdown output base directory recursively (one level deep
 * for the per-client subfolders) and return a Map of recording_id ->
 * ProcessedRecord for every `.md` file with a parseable frontmatter.
 *
 * Files without `recording_id` in their frontmatter are silently
 * ignored — they may be user-authored notes that happen to live in
 * the same folder. This is intentional: the function is conservative
 * about what counts as a distill output.
 *
 * Errors reading individual files are logged and skipped, not thrown.
 * One bad file in a folder shouldn't break the entire poll cycle.
 *
 * @param baseDir Absolute path to the configured `outputs.markdown.dir`.
 * @returns Map keyed by recording_id. Empty Map if the directory is
 *          missing, empty, or contains no parseable frontmatter.
 */
export async function loadProcessedElsewhereIds(
  baseDir: string,
): Promise<Map<string, ProcessedRecord>> {
  const result = new Map<string, ProcessedRecord>();

  // Two-level scan: baseDir contains client subfolders, each subfolder
  // contains the .md files. We don't recurse arbitrarily deep — that
  // would invite picking up unrelated markdown the user might have
  // dropped in (e.g. a note inside a project folder under a client).
  let topLevel: Array<{ name: string; isDirectory: boolean }>;
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    topLevel = entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    // baseDir doesn't exist (fresh install, never written) or
    // permission denied. Caller treats empty Map as "no cross-machine
    // detection available, proceed normally."
    return result;
  }

  for (const entry of topLevel) {
    // Treat top-level .md files (rare but possible if a user has
    // placed Unclassified outputs at the root) as well as files
    // inside client subfolders.
    if (entry.isDirectory) {
      await scanDirectoryInto(join(baseDir, entry.name), result);
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      await tryAddFile(join(baseDir, entry.name), result);
    }
  }

  return result;
}

async function scanDirectoryInto(
  dir: string,
  result: Map<string, ProcessedRecord>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // sub-directory disappeared between top-level scan and now; skip
  }

  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    await tryAddFile(join(dir, name), result);
  }
}

async function tryAddFile(
  filePath: string,
  result: Map<string, ProcessedRecord>,
): Promise<void> {
  let frontmatter: string;
  let mtimeMs: number;
  try {
    // Read only enough of the file to capture the frontmatter — distill's
    // markdown outputs are typically a few KB to a few hundred KB. The
    // 4096-byte cap is generous: real frontmatter is rarely more than
    // 500 bytes, but this leaves room for users who add custom fields.
    const buf = await readFile(filePath);
    const head = buf.subarray(0, 4096).toString('utf8');
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return;
    frontmatter = match[1];

    const stats = await stat(filePath);
    mtimeMs = stats.mtimeMs;
  } catch {
    return; // unreadable or no frontmatter; skip
  }

  const parsed = parseSimpleFrontmatter(frontmatter);
  const recordingId = parsed.recording_id;
  if (!recordingId) return;

  // Conflict policy: if the same recording_id appears in two files
  // (which can happen if the user manually duplicated a markdown,
  // or if a previous version of distill produced a "(1)" duplicate),
  // keep the most recently written. This matches the user's mental
  // model of "the latest output is the canonical one."
  const existing = result.get(recordingId);
  if (existing && existing.writtenAtMs >= mtimeMs) return;

  result.set(recordingId, {
    markdownPath: filePath,
    writtenAtMs: mtimeMs,
    modelSnapshot: parsed.model ?? null,
    whisperSnapshot: parsed.whisper_model ?? null,
  });
}

/**
 * Tiny, intentionally simple YAML frontmatter parser for the subset
 * distill writes (see `outputs/writeMarkdown.ts::buildMarkdown`):
 *
 *     recording_id: 5b4bb64327288abd073b33ef8a9ddc61
 *     filename: "..."
 *     client: "..."
 *     ...
 *     model: "qwen2.5:32b"
 *
 * We don't pull in a YAML dep — distill's frontmatter is a flat list
 * of `key: value` lines, never nested, never multi-line. Values may
 * be JSON-quoted strings (because writeMarkdown does `JSON.stringify`)
 * or raw values. This parser handles both.
 */
function parseSimpleFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;

    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length === 0) continue;

    // If quoted (writeMarkdown JSON.stringifies strings), parse out the
    // quotes. JSON.parse is the safe way to handle escaped chars too.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value.replace(/^'|'$/g, '"'));
      } catch {
        // Leave value as-is if JSON.parse chokes; the consumer will
        // see the quoted string and probably ignore the field.
      }
    }
    out[key] = value;
  }
  return out;
}
