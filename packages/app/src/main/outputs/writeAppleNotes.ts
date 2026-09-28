/**
 * Apple Notes output writer.
 *
 * Writes the note body via an osascript subprocess. AppleScript is the
 * only stable way to drive Notes.app from outside; Notes has no public
 * API or URL scheme that supports writing. The script is passed via
 * stdin (not `-e`) so we don't hit argv length limits for large notes.
 *
 * Folder layout:
 *   distill (or whatever parentFolder is configured)
 *   └── <Client name>
 *       └── <the note>
 *
 * Both the parent and the per-client subfolder are created if missing.
 * Notes accepts an HTML string as the note body — we feed it the same
 * fragment writeHtml produces, so formatting is consistent across
 * destinations.
 *
 * Returns the Notes.app note id so the caller can persist it. The id
 * survives renames but not deletion; if the user deletes the note in
 * Notes.app, a subsequent reveal will simply fail and we surface that
 * with a clear message.
 */

import { spawn } from 'node:child_process';
import { buildHtmlFragment } from './writeHtml.js';
import { type OutputSource } from './shared.js';

export interface AppleNotesWriteOptions {
  parentFolder: string;
  includeTranscript: boolean;
}

export interface AppleNotesWriteResult {
  /** Notes.app id URI, e.g. "x-coredata://...". */
  noteId: string;
}

export class AppleNotesError extends Error {
  constructor(public userMessage: string, cause?: unknown) {
    super(userMessage);
    this.name = 'AppleNotesError';
    if (cause instanceof Error) this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
  }
}

export async function writeAppleNote(
  row: OutputSource,
  opts: AppleNotesWriteOptions,
): Promise<AppleNotesWriteResult> {
  if (!row.summary_text) {
    throw new AppleNotesError('Cannot write note without a summary');
  }

  const clientFolder = (row.client_name ?? 'Unclassified').trim() || 'Unclassified';
  const body = await buildHtmlFragment(row, opts.includeTranscript);

  // AppleScript string escaping: backslash and double-quote are the
  // sequences we need to protect. Notes will receive the resulting
  // string as the `body` property and parse it as HTML.
  const script = buildAppleScript({
    parentFolder: opts.parentFolder,
    clientFolder,
    body,
  });

  const noteId = await runOsaScript(script);
  if (!noteId) {
    throw new AppleNotesError(
      'AppleScript ran but returned no note id. Check that Notes.app has permission — you may need to approve Automation permissions in System Settings.',
    );
  }
  return { noteId };
}

interface ScriptArgs {
  parentFolder: string;
  clientFolder: string;
  body: string;
}

/**
 * Build the AppleScript that creates folders as needed and the note.
 *
 * A subtle point: AppleScript's Notes dictionary uses `folder` at the
 * top of the account, and `folder` nested inside another folder for
 * subfolders. `make new folder at ...` is the idiomatic create.
 *
 * We reference the default account rather than a hard-coded "iCloud"
 * name because some users only have an "On My Mac" account, and some
 * non-English macOS locales localise the account name. `default account`
 * gives whatever Notes.app considers the writable default.
 */
function buildAppleScript(args: ScriptArgs): string {
  const parent = escapeForAppleScript(args.parentFolder);
  const child = escapeForAppleScript(args.clientFolder);
  const body = escapeForAppleScript(args.body);

  // The returned value is whatever `return` evaluates to, written to
  // stdout by osascript. `id of newNote` is a stable URI.
  return `
on run
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
end run
`;
}

function escapeForAppleScript(s: string): string {
  // Escape the two characters that terminate an AppleScript string
  // literal. Backslash first to avoid escaping our own escapes.
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Execute osascript with the given script on stdin. Returns the trimmed
 * stdout on success. Rejects with AppleNotesError on failure so callers
 * can surface user-friendly messages.
 */
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
      // Common: automation permission not granted. Detect and reword.
      const tail = stderr.split('\n').filter((l) => l.trim()).slice(-5).join('\n');
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
      reject(
        new AppleNotesError(
          `osascript failed (exit ${code}):\n${tail || stderr.slice(-500)}`,
        ),
      );
    });

    proc.stdin.write(script);
    proc.stdin.end();
  });
}
