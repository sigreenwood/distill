import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { marked } from 'marked';
import type { Logger } from './logger.js';
import type { JoinedRecordingRow } from './state.js';
import type { OutputsConfig } from './config.js';

// --- filenames -------------------------------------------------------------

export function sanitiseForFilename(s: string): string {
  return (
    s
      .replace(/[/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .trim() || 'untitled'
  );
}

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
 * Pull a human title out of the summary's first line, if the model gave
 * us one worth using. Returns null when the first line is a generic
 * header ("Executive Summary"), a numbered list item, or too short to be
 * descriptive — the caller falls back to the recording's filename.
 */
export function extractTitleFromSummary(summary: string | null): string | null {
  if (!summary) return null;
  const firstLine = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  if (/^\d+[.)]\s/.test(firstLine)) return null;
  let title = firstLine
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\*\*+|\*\*+$/g, '')
    .replace(/^__+|__+$/g, '')
    .replace(/^[*_]|[*_]$/g, '')
    .trim();
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
  title = title.replace(/[.!?:;,]+$/, '').trim();
  if (title.length === 0) return null;
  const words = title.split(/\s+/);
  if (words.length > 15) {
    title = words.slice(0, 15).join(' ');
  }
  if (title.split(/\s+/).length < 3) return null;
  return title;
}

export function buildFilenameStem(row: JoinedRecordingRow): string {
  const dateStr = formatDateForFilename(row.start_time);
  const client = sanitiseForFilename(row.client_name ?? 'Unclassified');
  const extracted = extractTitleFromSummary(row.summary_text);
  const titleSource = extracted ?? row.filename;
  const title = sanitiseForFilename(titleSource).slice(0, 80);
  return `${dateStr} - ${client} - ${title}`;
}

export function clientFolderName(row: JoinedRecordingRow): string {
  return sanitiseForFilename(row.client_name ?? 'Unclassified');
}

export function buildFilePath(baseDir: string, extension: string, row: JoinedRecordingRow): string {
  const dir = path.join(baseDir, clientFolderName(row));
  const stem = buildFilenameStem(row);
  return path.join(dir, `${stem}${extension}`);
}

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

// --- markdown --------------------------------------------------------------

export interface WriteFileOptions {
  baseDir: string;
  includeTranscript: boolean;
}

export async function writeMarkdown(
  row: JoinedRecordingRow,
  opts: WriteFileOptions,
): Promise<{ path: string }> {
  if (!row.summary_text) {
    throw new Error('Cannot write markdown without a summary');
  }
  const primary = buildFilePath(opts.baseDir, '.md', row);
  const targetPath = uniquifyPath(fs.existsSync, primary, '.md');
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const md = buildMarkdown(row, opts.includeTranscript);
  await fsp.writeFile(targetPath, md, 'utf-8');
  return { path: targetPath };
}

export function buildMarkdown(row: JoinedRecordingRow, includeTranscript: boolean): string {
  const frontmatter = [
    '---',
    `recording_id: ${row.id}`,
    `filename: ${JSON.stringify(row.filename)}`,
    `client: ${JSON.stringify(row.client_name ?? 'Unclassified')}`,
    `meeting_type: ${JSON.stringify(row.meeting_type_name ?? 'Unknown')}`,
    row.start_time ? `date: ${new Date(row.start_time).toISOString()}` : null,
    row.duration_seconds != null ? `duration_seconds: ${row.duration_seconds}` : null,
    row.model_snapshot ? `model: ${JSON.stringify(row.model_snapshot)}` : null,
    row.whisper_snapshot ? `whisper_model: ${JSON.stringify(row.whisper_snapshot)}` : null,
    row.vocabulary_sources ? `vocabulary_sources: ${JSON.stringify(row.vocabulary_sources)}` : null,
    row.vocabulary_rules_applied != null
      ? `vocabulary_rules_applied: ${row.vocabulary_rules_applied}`
      : null,
    `transcript_embedded: ${includeTranscript}`,
    '---',
    '',
  ]
    .filter((l): l is string => l !== null)
    .join('\n');
  const header = `# ${row.filename}\n\n`;
  const summarySection = `## Summary\n\n${row.summary_text?.trim() ?? ''}\n`;
  if (!includeTranscript) return frontmatter + header + summarySection;
  const transcriptSection = `\n---\n\n## Transcript\n\n${row.transcript_text?.trim() ?? ''}\n`;
  return frontmatter + header + summarySection + transcriptSection;
}

// --- html ------------------------------------------------------------------

export async function writeHtml(
  row: JoinedRecordingRow,
  opts: WriteFileOptions,
): Promise<{ path: string; html: string }> {
  if (!row.summary_text) {
    throw new Error('Cannot write HTML without a summary');
  }
  const primary = buildFilePath(opts.baseDir, '.html', row);
  const targetPath = uniquifyPath(fs.existsSync, primary, '.html');
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const html = await buildHtmlDocument(row, opts.includeTranscript);
  await fsp.writeFile(targetPath, html, 'utf-8');
  return { path: targetPath, html };
}

export async function buildHtmlDocument(
  row: JoinedRecordingRow,
  includeTranscript: boolean,
): Promise<string> {
  const fragment = await buildHtmlFragment(row, includeTranscript);
  const title = escapeHtml(row.filename);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
  body { font: 14px/1.55 -apple-system, 'SF Pro Text', 'Helvetica Neue', sans-serif; max-width: 720px; margin: 2em auto; padding: 0 1em; color: #1d1d1f; }
  h1 { font-size: 1.4em; border-bottom: 1px solid #ddd; padding-bottom: 0.3em; margin-top: 0; }
  h2 { font-size: 1.15em; margin-top: 1.6em; color: #333; }
  header.meta { font-size: 12px; color: #666; margin-bottom: 1.5em; }
  header.meta dt { font-weight: 600; display: inline; margin-right: 4px; }
  header.meta dd { display: inline; margin: 0 1em 0 0; }
  hr.divider { margin: 2em 0; border: none; border-top: 1px solid #eee; }
  .transcript { white-space: pre-wrap; font-family: 'SF Mono', ui-monospace, monospace; font-size: 12px; color: #444; }
  blockquote { border-left: 3px solid #ccc; padding-left: 1em; color: #555; margin: 1em 0; }
  code { font-family: 'SF Mono', ui-monospace, monospace; background: #f5f5f5; padding: 1px 4px; border-radius: 3px; }
  pre code { display: block; padding: 1em; overflow-x: auto; }
  @media print { body { margin: 0; max-width: none; } }
</style>
</head>
<body>
${fragment}
</body>
</html>
`;
}

export async function buildHtmlFragment(
  row: JoinedRecordingRow,
  includeTranscript: boolean,
): Promise<string> {
  const title = escapeHtml(row.filename);
  const meta = buildMetaBlock(row);
  const summaryHtml = await marked.parse(row.summary_text ?? '', { async: true });
  let doc = `<h1>${title}</h1>\n${meta}\n<h2>Summary</h2>\n${summaryHtml}\n`;
  if (includeTranscript && row.transcript_text) {
    const transcriptHtml = escapeHtml(row.transcript_text.trim());
    doc += `<hr class="divider">\n<h2>Transcript</h2>\n<div class="transcript">${transcriptHtml}</div>\n`;
  }
  return doc;
}

function buildMetaBlock(row: JoinedRecordingRow): string {
  const items: [string, string][] = [];
  if (row.client_name) items.push(['Client', row.client_name]);
  if (row.meeting_type_name) items.push(['Type', row.meeting_type_name]);
  if (row.start_time) {
    items.push(['Date', new Date(row.start_time).toLocaleString()]);
  }
  if (row.duration_seconds != null) {
    items.push(['Duration', formatDuration(row.duration_seconds)]);
  }
  if (row.model_snapshot) items.push(['Model', row.model_snapshot]);
  if (row.vocabulary_rules_applied != null && row.vocabulary_rules_applied > 0) {
    items.push(['Corrections', `${row.vocabulary_rules_applied} applied (${row.vocabulary_sources ?? ''})`]);
  }
  if (items.length === 0) return '';
  const dlEntries = items.map(([k, v]) => `<dt>${escapeHtml(k)}:</dt><dd>${escapeHtml(v)}</dd>`).join(' ');
  return `<header class="meta"><dl>${dlEntries}</dl></header>`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --- apple notes -----------------------------------------------------------

/**
 * How long to let Notes.app take before giving up. Ten minutes is
 * generous, but the alternative — the 60-second AppleEvent default —
 * fails on ordinary meeting summaries, and a slow note is much better
 * than a spurious error.
 */
const APPLE_NOTES_TIMEOUT_SECONDS = 600;

export class AppleNotesError extends Error {
  userMessage: string;

  constructor(userMessage: string, cause?: unknown) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = 'AppleNotesError';
    if (cause instanceof Error) this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
  }
}

export async function writeAppleNote(
  row: JoinedRecordingRow,
  opts: { parentFolder: string; includeTranscript: boolean },
): Promise<{ noteId: string }> {
  if (!row.summary_text) {
    throw new AppleNotesError('Cannot write note without a summary');
  }
  const clientFolder = (row.client_name ?? 'Unclassified').trim() || 'Unclassified';
  const body = await buildHtmlFragment(row, opts.includeTranscript);
  const script = buildAppleScript({ parentFolder: opts.parentFolder, clientFolder, body });
  const noteId = await runOsaScript(script);
  if (!noteId) {
    throw new AppleNotesError(
      'AppleScript ran but returned no note id. Check that Notes.app has permission — you may need to approve Automation permissions in System Settings.',
    );
  }
  return { noteId };
}

function buildAppleScript(args: { parentFolder: string; clientFolder: string; body: string }): string {
  const parent = escapeForAppleScript(args.parentFolder);
  const child = escapeForAppleScript(args.clientFolder);
  const body = escapeForAppleScript(args.body);
  // `with timeout` is load-bearing: AppleEvents default to 60 seconds,
  // and Notes.app routinely takes longer than that to accept a note
  // whose body is a full meeting summary (worse again with the
  // transcript embedded, and worse still when Notes is syncing to
  // iCloud). Without it the pipeline reports "AppleEvent timed out
  // (-1712)" while Notes is still working — and may well go on to
  // create the note anyway, leaving a failure that isn't one.
  return `
on run
  with timeout of ${APPLE_NOTES_TIMEOUT_SECONDS} seconds
    tell application "Notes"
      set acct to default account
      tell acct
        if not (exists folder "${parent}") then
          make new folder with properties {name:"${parent}"}
        end if
        tell folder "${parent}"
          if not (exists folder "${child}") then
            make new folder with properties {name:"${child}"}
          end if
          tell folder "${child}"
            set newNote to make new note with properties {body:"${body}"}
            return id of newNote
          end tell
        end tell
      end tell
    end tell
  end timeout
end run
`;
}

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runOsaScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.once('error', (err) =>
      reject(
        new AppleNotesError(
          `Could not run osascript: ${err.message}. This should be built in on macOS — if it's missing, something is very wrong.`,
          err,
        ),
      ),
    );
    proc.once('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      const tail = stderr
        .split('\n')
        .filter((l) => l.trim())
        .slice(-5)
        .join('\n');
      if (/not authorized|permission/i.test(stderr)) {
        reject(
          new AppleNotesError(
            'macOS denied distill permission to control Notes.app. Open System Settings → Privacy & Security → Automation, find distill (or your Terminal in dev mode), and enable Notes.',
          ),
        );
        return;
      }
      if (/doesn.?t understand/i.test(stderr)) {
        reject(
          new AppleNotesError(
            `Notes.app rejected the AppleScript. This can happen on older macOS versions. Error: ${tail}`,
          ),
        );
        return;
      }
      reject(new AppleNotesError(`osascript failed (exit ${code}):\n${tail || stderr.slice(-500)}`));
    });
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

// --- multi-destination write ----------------------------------------------

export interface WriteOutputsSkip {
  markdown: boolean;
  html: boolean;
  appleNotes: boolean;
}

export interface WriteOutputsResult {
  markdownPath: string | null;
  htmlPath: string | null;
  appleNoteId: string | null;
  failures: { destination: 'markdown' | 'html' | 'appleNotes'; message: string }[];
  successCount: number;
  attemptedCount: number;
}

/**
 * Write every enabled destination that hasn't already succeeded (per the
 * skip flags derived from *_written_at). Destinations run in parallel and
 * fail independently — one failing destination never blocks the others.
 */
export async function writeOutputs(
  row: JoinedRecordingRow,
  outputs: OutputsConfig,
  logger: Logger,
  skip: WriteOutputsSkip = { markdown: false, html: false, appleNotes: false },
): Promise<WriteOutputsResult> {
  const result: WriteOutputsResult = {
    markdownPath: null,
    htmlPath: null,
    appleNoteId: null,
    failures: [],
    successCount: 0,
    attemptedCount: 0,
  };
  const tasks: Promise<void>[] = [];
  if (outputs.markdown.enabled && !skip.markdown) {
    result.attemptedCount++;
    tasks.push(
      writeMarkdown(row, {
        baseDir: outputs.markdown.dir,
        includeTranscript: outputs.markdown.includeTranscript,
      })
        .then((r) => {
          result.markdownPath = r.path;
          result.successCount++;
          logger.info({ id: row.id, path: r.path }, 'markdown output written');
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          result.failures.push({ destination: 'markdown', message: msg });
          logger.warn({ id: row.id, err: msg }, 'markdown output failed');
        }),
    );
  }
  if (outputs.html.enabled && !skip.html) {
    result.attemptedCount++;
    tasks.push(
      writeHtml(row, {
        baseDir: outputs.html.dir,
        includeTranscript: outputs.html.includeTranscript,
      })
        .then((r) => {
          result.htmlPath = r.path;
          result.successCount++;
          logger.info({ id: row.id, path: r.path }, 'html output written');
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          result.failures.push({ destination: 'html', message: msg });
          logger.warn({ id: row.id, err: msg }, 'html output failed');
        }),
    );
  }
  if (outputs.appleNotes.enabled && !skip.appleNotes) {
    result.attemptedCount++;
    tasks.push(
      writeAppleNote(row, {
        parentFolder: outputs.appleNotes.parentFolder,
        includeTranscript: outputs.appleNotes.includeTranscript,
      })
        .then((r) => {
          result.appleNoteId = r.noteId;
          result.successCount++;
          logger.info({ id: row.id, noteId: r.noteId }, 'apple note written');
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          result.failures.push({ destination: 'appleNotes', message: msg });
          logger.warn({ id: row.id, err: msg }, 'apple notes output failed');
        }),
    );
  }
  await Promise.all(tasks);
  return result;
}
