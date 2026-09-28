/**
 * Output fan-out.
 *
 * Given a recording row and the outputs config, run every enabled writer
 * that hasn't already been written. Each writer is independent: a failure
 * in one does not block the others. The result reports which wrote
 * successfully with their paths/ids and which failed with their errors,
 * so the pipeline step can persist the successes (via per-destination
 * `*_written_at` timestamps) and surface the failures.
 */

import type { Logger } from 'pino';
import type { OutputsConfig } from '../config.js';
import type { OutputSource } from './shared.js';
import { writeMarkdown } from './writeMarkdown.js';
import { writeHtml } from './writeHtml.js';
import { writeAppleNote } from './writeAppleNotes.js';

export interface OutputResults {
  /**
   * Markdown output path, populated only if this call's write succeeded.
   * Null otherwise — the pipeline step is responsible for *not*
   * overwriting a pre-existing `markdown_path` on the row with null.
   */
  markdownPath: string | null;
  htmlPath: string | null;
  appleNoteId: string | null;
  /** One entry per destination that was enabled-and-not-skipped but failed. */
  failures: OutputFailure[];
  /** Count of destinations that wrote successfully in THIS call. */
  successCount: number;
  /**
   * Count of destinations that ran in this call (i.e. enabled and not
   * already written). Used by the pipeline step to decide between
   * complete / error / no-op.
   */
  attemptedCount: number;
}

export interface OutputFailure {
  destination: 'markdown' | 'html' | 'appleNotes';
  message: string;
}

/**
 * Destinations whose prior write should be respected and NOT re-run. The
 * pipeline step derives this from the row's `*_written_at` timestamps
 * before calling writeOutputs, so the fan-out stays a pure function of
 * (row, config, skip) with no DB awareness.
 */
export interface SkipDestinations {
  markdown: boolean;
  html: boolean;
  appleNotes: boolean;
}

export async function writeOutputs(
  row: OutputSource,
  outputs: OutputsConfig,
  logger: Logger,
  skip: SkipDestinations = { markdown: false, html: false, appleNotes: false },
): Promise<OutputResults> {
  const result: OutputResults = {
    markdownPath: null,
    htmlPath: null,
    appleNoteId: null,
    failures: [],
    successCount: 0,
    attemptedCount: 0,
  };

  const tasks: Array<Promise<void>> = [];

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

export type { OutputSource } from './shared.js';
