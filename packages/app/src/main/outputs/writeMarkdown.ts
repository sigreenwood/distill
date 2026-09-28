/**
 * Markdown file output writer.
 *
 * Builds a Markdown document with YAML frontmatter, then the summary,
 * then optionally the transcript. The frontmatter captures the metadata
 * the user might want to pivot on later (model, vocabulary stats, etc.)
 * without cluttering the prose.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  buildFilePath,
  uniquifyPath,
  type OutputSource,
} from './shared.js';

export interface MarkdownWriteOptions {
  baseDir: string;
  includeTranscript: boolean;
}

export interface MarkdownWriteResult {
  path: string;
}

export async function writeMarkdown(
  row: OutputSource,
  opts: MarkdownWriteOptions,
): Promise<MarkdownWriteResult> {
  if (!row.summary_text) {
    throw new Error('Cannot write markdown without a summary');
  }

  const primary = buildFilePath(opts.baseDir, '.md', row);
  const targetPath = uniquifyPath(existsSync, primary, '.md');
  await mkdir(dirname(targetPath), { recursive: true });

  const md = buildMarkdown(row, opts.includeTranscript);
  await writeFile(targetPath, md, 'utf-8');

  return { path: targetPath };
}

function buildMarkdown(row: OutputSource, includeTranscript: boolean): string {
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
    row.vocabulary_sources
      ? `vocabulary_sources: ${JSON.stringify(row.vocabulary_sources)}`
      : null,
    row.vocabulary_rules_applied != null
      ? `vocabulary_rules_applied: ${row.vocabulary_rules_applied}`
      : null,
    `transcript_embedded: ${includeTranscript}`,
    '---',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');

  const header = `# ${row.filename}\n\n`;
  const summarySection = `## Summary\n\n${row.summary_text?.trim() ?? ''}\n`;

  if (!includeTranscript) return frontmatter + header + summarySection;

  const transcriptSection = `\n---\n\n## Transcript\n\n${row.transcript_text?.trim() ?? ''}\n`;
  return frontmatter + header + summarySection + transcriptSection;
}
