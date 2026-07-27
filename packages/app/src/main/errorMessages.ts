/**
 * Translate raw pipeline error strings into short, actionable messages
 * for the inbox UI. Rules are checked in order; first match wins. A rule
 * with isAuthError makes the inbox show a "Sign in again" button.
 */

export interface PrettifyContext {
  step?: string | null;
  ollamaHost?: string;
  ollamaModel?: string;
  appSupportDir?: string;
  isPackaged?: boolean;
}

interface Rule {
  pattern: RegExp;
  build: (m: RegExpMatchArray, ctx: PrettifyContext) => string;
  isAuthError?: boolean;
}

const RULES: Rule[] = [
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
    pattern: /Ollama\s+stream\s+error|Ollama\s+5\d\d/i,
    build: () =>
      'Ollama errored during generation. This usually means it ran out of memory — try a smaller model, shorter transcript, or restart Ollama.',
  },
  {
    pattern: /Ollama\s+response\s+had\s+no\s+body|Ollama\s+stream\s+ended\s+without/i,
    build: () => 'Ollama closed the connection before finishing. If this repeats, restart the Ollama app.',
  },
  {
    // Node's undici reports a socket that died mid-request as a bare
    // "fetch failed", with no cause worth surfacing. During summarise
    // that almost always means Ollama was killed allocating memory:
    // the KV cache is charged on top of the model weights and scales
    // with num_ctx, so a large context on a memory-tight Mac fails
    // even on a one-word prompt. Measured: 27B model + 64k context
    // needs ~28GB and dies on a 24GB machine; 32k is stable.
    pattern: /^fetch failed$|fetch failed/i,
    build: (_m, ctx) => {
      const model = ctx.ollamaModel ?? 'the configured model';
      return (
        `Lost the connection to Ollama while summarising with "${model}". ` +
        'This usually means Ollama ran out of memory allocating its context. ' +
        'Lower contextWindow in config.json (32768 is a safe value on a 24GB Mac), ' +
        'or switch to a smaller model in Settings → Performance, then Retry.'
      );
    },
  },
  // --- Plaud download ------------------------------------------------------
  {
    pattern: /getMp3Url\s+returned\s+null|Plaud\s+did\s+not\s+return\s+a\s+download\s+URL/i,
    build: () =>
      'Plaud did not return a download URL for this recording. It may have been deleted on the Plaud cloud — try Sync, then retry, or skip if it is gone.',
  },
  {
    pattern: /Download\s+failed:\s+HTTP\s+40[13]/i,
    build: () => 'Plaud refused the download (auth expired). Open Settings → Sources to sign in again.',
    isAuthError: true,
  },
  {
    // Surfaces when the poller / pipeline runs after a Sign Out has
    // cleared credentials but a row was already in flight. Also covers
    // the case where a user newly installed and never signed in.
    pattern: /No\s+credentials\s+configured|Plaud\s+not\s+(?:authenticated|signed\s+in)/i,
    build: () => 'Not signed in to Plaud. Open Settings → Sources to sign in.',
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
    build: () => 'The downloaded audio file was empty. Retry; if it happens again the cloud copy may be corrupt.',
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
    build: () => 'Whisper returned no text. The audio may be silent, music-only, or too short for speech detection.',
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
        return `mlx_whisper is not installed in the Python venv. Quit distill, delete ${ctx.appSupportDir}/venv, and re-launch to re-run first-launch setup.`;
      }
      return 'mlx_whisper is not installed in the Python venv. Run: cd packages/app/python && uv pip install -r requirements.txt';
    },
  },
  // --- Apple Notes ---------------------------------------------------------
  {
    // -1712 is the AppleEvent timeout. Notes.app is often still working
    // (and may create the note anyway) when this fires, so the honest
    // message says so rather than implying the write definitely failed.
    pattern: /AppleEvent timed out|-1712/i,
    build: () =>
      'Notes.app took too long to accept the note. It may still have been created — check the folder in Notes before retrying, or turn Apple Notes off in Settings → Outputs if it keeps timing out. Markdown and HTML are unaffected.',
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
    build: () => 'DNS lookup failed. Check your internet connection; Plaud and Ollama both need to be reachable.',
  },
  {
    pattern: /aborted|The operation was aborted/i,
    build: () =>
      'The operation was aborted. This is usually a cancel-in-flight, but if you did not cancel, it might be a network hiccup — retry.',
  },
];

export function prettifyError(
  rawMessage: string,
  ctx: PrettifyContext = {},
): { message: string; isAuthError: boolean } {
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
  return { message: summariseUnmatched(msg), isAuthError: false };
}

/**
 * Fallback for errors no rule matched.
 *
 * This used to return only the first line, which produced messages that
 * stopped before saying anything useful — a real example from the write
 * step:
 *
 *   "Partial output failure (2/3 attempted succeeded this run).
 *    appleNotes: osascript failed (exit 1):"
 *
 * The line ends on a colon because the actual reason ("AppleEvent timed
 * out") was on the next line. Nested tool output (osascript, python,
 * ffmpeg) routinely puts the cause on a later line, so take the first
 * few non-empty lines, flatten them into one sentence, and only then
 * truncate.
 */
function summariseUnmatched(msg: string): string {
  const lines = msg
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return 'Unknown error';
  const joined = lines.slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > 240 ? joined.slice(0, 237) + '…' : joined;
}
