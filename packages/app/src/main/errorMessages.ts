/**
 * Friendlier error messages.
 *
 * The pipeline worker catches raw exceptions from its steps and stores the
 * `.message` on the recording row. Those messages are often terse or
 * formatted for developers (HTTP codes, errno strings, stack-trace tails).
 *
 * This module maps common error patterns to actionable user-facing text.
 * Fall-through behaviour is to return the raw message unchanged, so any
 * unrecognised error still reaches the user — just not prettified.
 *
 * The prettifier is pure (no I/O, no logging), cheap (one regex per entry),
 * and deterministic. Adding cases is low risk: each entry is one pattern
 * plus one replacement.
 *
 * Path-aware messages (mlx_whisper missing, EACCES) take the support
 * directory and the dev-vs-packaged flag through PrettifyContext rather
 * than importing electron directly. Keeps this module test-runnable in
 * plain Node.
 */

export interface PrettifyContext {
  /** Last pipeline step that was running, if known. Used to disambiguate
   *  errors that can happen in multiple steps. */
  step?: string | null;
  /** Ollama host from config, so error text can reference the correct URL. */
  ollamaHost?: string;
  /** Ollama model from config. */
  ollamaModel?: string;
  /**
   * Absolute path to the user's app-support directory. Surfaced in
   * path-related errors (EACCES, mlx_whisper missing) so the message
   * names the actual directory rather than a generic path. Optional so
   * tests can omit it; messages fall back to a generic phrasing when
   * absent.
   */
  appSupportDir?: string;
  /**
   * True when running in a packaged build (.app launched from
   * /Applications). Toggles between dev-friendly remediation
   * ("cd packages/app/python && uv pip install -r requirements.txt")
   * and packaged-friendly remediation ("delete <appSupportDir>/venv
   * and re-launch to re-run setup"). Optional; absent === dev-style
   * wording.
   */
  isPackaged?: boolean;
}

interface ErrorRule {
  /** Regex matched against the raw message. */
  pattern: RegExp;
  /** Replacement builder. Receives the match and context. */
  build: (m: RegExpMatchArray, ctx: PrettifyContext) => string;
  /**
   * True iff matching this rule means the user can resolve the error
   * by signing in again to a source (e.g. Plaud auth expired). The
   * inbox UI surfaces a contextual "Sign in again" button on rows
   * where this is set. See InboxRecordingDTO.isAuthError.
   */
  isAuthError?: boolean;
}

const RULES: ErrorRule[] = [
  // --- Ollama --------------------------------------------------------------

  {
    // Both "ECONNREFUSED" (Node fetch on a closed port) and Ollama's own
    // "connection refused" come through here. We key on the 11434 default
    // port to make sure we're specifically talking about Ollama.
    pattern: /ECONNREFUSED.*?:?11434|Connection refused|Ollama is not reachable/i,
    build: () =>
      'Ollama is not running. Start it from the menu bar or run `ollama serve` in Terminal, then click Retry.',
  },
  {
    // Ollama returns 404 for missing models; also responds "model not found"
    // in JSON error bodies in some versions.
    pattern: /Ollama\s+404|model\s+"?([^"\s]+)"?\s+not\s+found|pull the model first/i,
    build: (_m, ctx) => {
      const model = ctx.ollamaModel ?? 'the configured model';
      return `Ollama model "${model}" is not installed. Pull it with: ollama pull ${model}`;
    },
  },
  {
    pattern: /Insufficient\s+Memory|OutOfMemory|Ollama\s+stream\s+error|Ollama\s+5\d\d/i,
    build: (m) =>
      /Insufficient\s+Memory|OutOfMemory/i.test(m[0])
        ? 'Ollama ran out of unified memory. Close other heavy apps or use a smaller model such as qwen3:14b, then retry.'
        : 'Ollama errored during generation. This usually means it ran out of memory — try a smaller model, shorter transcript, or restart Ollama.',
  },
  {
    pattern: /Ollama\s+response\s+had\s+no\s+body|Ollama\s+stream\s+ended\s+without/i,
    build: () =>
      'Ollama closed the connection before finishing. If this repeats, restart the Ollama app.',
  },

  // --- Plaud download ------------------------------------------------------

  {
    pattern: /getMp3Url\s+returned\s+null|Plaud\s+did\s+not\s+return\s+a\s+download\s+URL/i,
    build: () =>
      'Plaud did not return a download URL for this recording. It may have been deleted on the Plaud cloud — try Sync, then retry, or skip if it is gone.',
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+40[13]/i,
    build: () =>
      'Plaud refused the download (auth expired). Open Settings → Sources to sign in again.',
    isAuthError: true,
  },
  {
    // Surfaces when the poller / pipeline runs after a Sign Out has
    // cleared credentials but a row was already in flight. Also covers
    // the case where a user newly installed and never signed in.
    pattern: /No\s+credentials\s+configured|Plaud\s+not\s+(?:authenticated|signed\s+in)/i,
    build: () =>
      'Not signed in to Plaud. Open Settings → Sources to sign in.',
    isAuthError: true,
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+404/i,
    build: () =>
      'Plaud returned 404 for this recording — it has probably been deleted server-side. You can safely skip it.',
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+5\d\d/i,
    build: () => 'Plaud had a server error during download. Retry in a minute or two.',
  },
  {
    pattern: /Downloaded\s+file\s+is\s+empty/i,
    build: () =>
      'The downloaded audio file was empty. Retry; if it happens again the cloud copy may be corrupt.',
  },

  // --- Transcription (Python / MLX) ---------------------------------------

  {
    pattern: /Transcription\s+failed\s+\(exit\s+(-?\d+)\)/i,
    build: (m) => {
      const code = m[1];
      return `Transcription crashed (exit ${code}). Check the log for the Python traceback; common causes are out-of-memory on very long recordings or a corrupt audio file.`;
    },
  },
  {
    pattern: /Transcription\s+output\s+was\s+not\s+valid\s+JSON/i,
    build: () =>
      'Whisper finished but its output was malformed. Check the log — this is usually a warning Python printed to stdout by mistake.',
  },
  {
    pattern: /Transcription\s+produced\s+an\s+empty\s+transcript/i,
    build: () =>
      'Whisper returned no text. The audio may be silent, music-only, or too short for speech detection.',
  },
  {
    // Python ModuleNotFoundError, most often mlx_whisper venv not set up.
    // Remediation differs between dev and packaged:
    //   - dev: rebuild the venv with uv pip install
    //   - packaged: delete the user-data venv so first-launch setup
    //               re-runs on relaunch (no source tree available)
    pattern: /ModuleNotFoundError.*mlx_whisper|No module named\s+['"]mlx_whisper['"]/i,
    build: (_m, ctx) => {
      if (ctx.isPackaged && ctx.appSupportDir) {
        return (
          `mlx_whisper is not installed in the Python venv. ` +
          `Quit distill, delete ${ctx.appSupportDir}/venv, and re-launch ` +
          `to re-run first-launch setup.`
        );
      }
      return (
        'mlx_whisper is not installed in the Python venv. ' +
        'Run: cd packages/app/python && uv pip install -r requirements.txt'
      );
    },
  },

  // --- Filesystem ----------------------------------------------------------

  {
    pattern: /ENOSPC|no\s+space\s+left\s+on\s+device/i,
    build: () => 'Disk is full. Free space and retry.',
  },
  {
    pattern: /EACCES|permission\s+denied/i,
    build: (m, ctx) => {
      const dir = ctx.appSupportDir ?? '~/Library/Application Support/distill';
      return `Permission denied: ${m[0]}. Check file/folder permissions around ${dir} and the Markdown output folder.`;
    },
  },
  {
    pattern: /ENOENT.*\.mp3/i,
    build: () =>
      'The audio file on disk has gone missing (was it deleted manually?). Cancel this recording and re-pull from Plaud if needed.',
  },

  // --- Network -------------------------------------------------------------

  {
    pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    build: () =>
      'DNS lookup failed. Check your internet connection; Plaud and Ollama both need to be reachable.',
  },
  {
    pattern: /aborted|The operation was aborted/i,
    build: () =>
      'The operation was aborted. This is usually a cancel-in-flight, but if you did not cancel, it might be a network hiccup — retry.',
  },
];

/**
 * Result of error-message prettification: the user-facing message plus
 * a flag for whether the error is an auth failure (used by the inbox UI
 * to render a "Sign in again" button on the row).
 */
export interface PrettifyResult {
  message: string;
  isAuthError: boolean;
}

/**
 * Map a raw exception message to a friendlier one. Returns the original
 * message unchanged (with isAuthError=false) if no rule matches, so
 * unknown errors still surface.
 */
export function prettifyError(rawMessage: string, ctx: PrettifyContext = {}): PrettifyResult {
  const msg = rawMessage.trim();
  if (!msg) return { message: 'Unknown error', isAuthError: false };

  for (const rule of RULES) {
    const match = msg.match(rule.pattern);
    if (match) {
      return {
        message: rule.build(match, ctx),
        isAuthError: rule.isAuthError === true,
      };
    }
  }

  // For truly unknown errors, trim verbose stack-trace tails so the inbox
  // UI doesn't show a wall of text. Keep first line + at most 200 chars.
  const firstLine = msg.split('\n')[0] ?? msg;
  const trimmed = firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
  return { message: trimmed, isAuthError: false };
}
