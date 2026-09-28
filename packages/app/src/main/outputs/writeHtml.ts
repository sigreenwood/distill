/**
 * HTML file output writer.
 *
 * Converts the summary (which is Markdown from Ollama) to HTML via the
 * `marked` library, wraps it in a minimal HTML5 shell with print-friendly
 * CSS, and saves it alongside the Markdown output (or to its own configured
 * directory). The body is self-contained so you can email the file as-is
 * or open it directly in a browser.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { marked } from 'marked';
import {
  buildFilePath,
  uniquifyPath,
  type OutputSource,
} from './shared.js';

export interface HtmlWriteOptions {
  baseDir: string;
  includeTranscript: boolean;
}

export interface HtmlWriteResult {
  path: string;
  html: string;
}

export async function writeHtml(
  row: OutputSource,
  opts: HtmlWriteOptions,
): Promise<HtmlWriteResult> {
  if (!row.summary_text) {
    throw new Error('Cannot write HTML without a summary');
  }

  const primary = buildFilePath(opts.baseDir, '.html', row);
  const targetPath = uniquifyPath(existsSync, primary, '.html');
  await mkdir(dirname(targetPath), { recursive: true });

  const html = await buildHtmlDocument(row, opts.includeTranscript);
  await writeFile(targetPath, html, 'utf-8');

  return { path: targetPath, html };
}

/**
 * Public because the Apple Notes writer also wants the body-only HTML
 * fragment (Notes accepts an HTML string and renders it as the note's
 * content). Returns a full HTML5 document when called via writeHtml,
 * and a body fragment (no <html>/<head>) via buildHtmlFragment below.
 */
export async function buildHtmlDocument(
  row: OutputSource,
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

/**
 * Body-only HTML for embedding inside other containers — specifically,
 * Apple Notes, which takes a body string and renders it as the note.
 * This contains the header, metadata, summary, and optionally the
 * transcript, but no full-document <html>/<head>/<style> scaffolding.
 */
export async function buildHtmlFragment(
  row: OutputSource,
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

function buildMetaBlock(row: OutputSource): string {
  const items: Array<[string, string]> = [];
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
    items.push([
      'Corrections',
      `${row.vocabulary_rules_applied} applied (${row.vocabulary_sources ?? ''})`,
    ]);
  }

  if (items.length === 0) return '';
  const dlEntries = items
    .map(
      ([k, v]) =>
        `<dt>${escapeHtml(k)}:</dt><dd>${escapeHtml(v)}</dd>`,
    )
    .join(' ');
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

/**
 * Minimal HTML-entity escaping for interpolated user strings. We're not
 * rendering attacker-controlled HTML anywhere, but defence in depth:
 * summary_text flows through marked (which handles this), meta values go
 * through here.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
