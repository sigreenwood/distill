/**
 * Pipeline steps.
 *
 * Each step is an async function that:
 *   - Reads the recording row fresh from the database
 *   - Respects an AbortSignal (throws CancelledError on abort)
 *   - Writes its output to the row on success before returning
 *   - Does NOT itself change `status` (the worker does that)
 *
 * The "output written on success" rule is what makes the pipeline
 * crash-recoverable: on restart the worker can inspect each output field
 * to decide which steps have already been done, and restart from the
 * first unfinished step.
 */

import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { audioDir, userVocabularyDir } from '../paths.js';
import { CancelledError, isCancelled, type PipelineContext } from './types.js';
import { applyReplacements, loadVocabulary } from '../vocabulary.js';
import { cleanWhisperRepetitions } from '../transcriptCleanup.js';
import { estimateTokenBudget } from './tokenBudget.js';
import { writeOutputs, type SkipDestinations } from '../outputs/index.js';
import { bundledPythonDir, bundledResourcesDir, bundledTranscribeScript } from '../bundledResources.js';
import { venvPython } from '../pythonSetup.js';
import type { RecordingRow, State } from '../state.js';

/**
 * The shape of the patch accepted by State.setStatus. We derive it from
 * the State type directly so any future field additions there flow
 * automatically into the steps code below without a second declaration
 * to keep in sync.
 */
type WriteStepPatch = NonNullable<Parameters<State['setStatus']>[2]>;

// ---------------------------------------------------------------------------
// doDownload
// ---------------------------------------------------------------------------

export async function doDownload(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'download');

  // Get a signed URL from Plaud. Using getMp3Url rather than downloadAudio()
  // so we can stream to disk with an AbortSignal rather than buffering the
  // whole file in memory.
  const url = await ctx.plaud.getMp3Url(id);
  if (!url) throw new Error('Plaud did not return a download URL for this recording');

  const dir = audioDir();
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${id}.mp3`);

  // If a partial file from a previous attempt exists, remove it — we cannot
  // resume an HTTP download mid-stream without range support, and validating
  // a partial MP3 is not worth the complexity.
  if (existsSync(dest)) unlinkSync(dest);

  ctx.logger.info({ id, dest }, 'downloading audio');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error('Download failed: empty response body');

  try {
    await streamPipeline(
      Readable.fromWeb(res.body as unknown as ReadableStream<Uint8Array>),
      createWriteStream(dest),
      { signal },
    );
  } catch (e) {
    // Partial file on cancel / error — clean up so the next retry starts fresh.
    if (existsSync(dest)) {
      try {
        unlinkSync(dest);
      } catch {
        // swallow cleanup errors
      }
    }
    if (isCancelled(e)) throw new CancelledError('download');
    throw e;
  }

  const size = statSync(dest).size;
  if (size === 0) {
    unlinkSync(dest);
    throw new Error('Downloaded file is empty');
  }

  ctx.state.setStatus(id, 'downloading', { audio_path: dest });
  ctx.logger.info({ id, bytes: size }, 'download complete');
}

// ---------------------------------------------------------------------------
// doTranscribe
// ---------------------------------------------------------------------------

interface TranscribeOutput {
  text: string;
  language: string;
  model: string;
  duration_seconds: number;
}

export async function doTranscribe(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'transcribe');
  const row = ctx.state.getRecording(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.audio_path) throw new Error('Cannot transcribe without an audio file');

  // Vocabulary lookup — we need it here so we can both bias Whisper at
  // transcription time and rewrite the output afterwards. Loaded fresh each
  // transcription so JSON edits take effect without an app restart.
  const vocabularyDir = userVocabularyDir();
  const vocab = loadVocabulary(vocabularyDir, row.client_id);
  if (vocab.sources.length > 0) {
    ctx.logger.info(
      {
        id,
        sources: vocab.sources,
        hintsChars: vocab.whisperPrompt.length,
        replacements: vocab.replacements.length,
      },
      'vocabulary loaded',
    );
  }

  const cfg = ctx.getConfig();
  const pyBinary = resolvePythonBinary(ctx.packageDir);
  const script = bundledTranscribeScript();

  const args = [script, '--audio', row.audio_path, '--whisper-model', cfg.whisperModel];
  if (vocab.whisperPrompt) {
    args.push('--initial-prompt', vocab.whisperPrompt);
  }
  ctx.logger.info({ id, pyBinary, model: cfg.whisperModel }, 'starting transcription');

  const proc = spawn(pyBinary, args, { signal });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exitCode: number = await new Promise((resolve, reject) => {
    proc.once('error', (err) => {
      if (isCancelled(err)) reject(new CancelledError('transcribe'));
      else reject(err);
    });
    proc.once('close', (code) => resolve(code ?? -1));
  });

  if (signal.aborted) throw new CancelledError('transcribe');

  if (exitCode !== 0) {
    throw new Error(`Transcription failed (exit ${exitCode}): ${stderr.slice(-500)}`);
  }

  let parsed: TranscribeOutput;
  try {
    parsed = JSON.parse(stdout.trim()) as TranscribeOutput;
  } catch (e) {
    throw new Error(
      `Transcription output was not valid JSON. Last 500 chars of stderr: ${stderr.slice(-500)}`,
    );
  }
  if (!parsed.text || parsed.text.trim().length === 0) {
    throw new Error('Transcription produced an empty transcript');
  }

  // Post-transcription replacements. These fix homophones and known
  // mistranscriptions that Whisper's initial_prompt alone can't reliably
  // fix. Running them here (before summarise) means the summariser sees
  // the corrected text, and the corrected text is what gets persisted so
  // the final Markdown output is consistent.
  const { text: corrected, applied } = applyReplacements(parsed.text, vocab.replacements);
  if (applied > 0) {
    ctx.logger.info(
      { id, rulesApplied: applied, totalRules: vocab.replacements.length },
      'applied vocabulary replacements',
    );
  }

  // Whisper repetition cleanup. Hallucinated repeats ("Repeat Repeat
  // Repeat...", "Yeah. Yeah. Yeah...") are collapsed before the row is
  // persisted so the summariser, the stored transcript, and any future
  // search index all see the cleaned text. See transcriptCleanup.ts
  // for the strategy and thresholds.
  const { text: cleaned, runsCollapsed, charsRemoved } = cleanWhisperRepetitions(corrected);
  if (runsCollapsed > 0) {
    ctx.logger.info(
      { id, runsCollapsed, charsRemoved, originalChars: corrected.length },
      'cleaned whisper repetitions',
    );
  }

  ctx.state.setStatus(id, 'transcribing', {
    transcript_text: cleaned,
    whisper_snapshot: parsed.model,
    vocabulary_sources: vocab.sources.join(','),
    vocabulary_rules_applied: applied,
  });
  ctx.logger.info(
    { id, chars: corrected.length, language: parsed.language },
    'transcription complete',
  );
}

function resolvePythonBinary(packageDir: string): string {
  // Resolution order:
  //
  //   1. The user-installed venv at appSupportDir/venv. This is where
  //      first-launch setup creates it (commits 3+ in the packaging arc).
  //      In a packaged build this is the ONLY working path — the dev
  //      tree's python/.venv doesn't exist on a fresh install.
  //
  //   2. The dev-tree venv at packages/app/python/.venv. A contributor
  //      running from a checked-out repo will have this from when the
  //      venv was hand-built with `uv venv`. Lets `npm run dev` work
  //      without having to first complete the first-launch setup flow.
  //
  //   3. Throw with a clear error. Falling back to system `python3` would
  //      silently succeed at the spawn but fail at `import mlx_whisper`,
  //      producing an opaque "transcription failed" message. Surfacing
  //      the missing-venv condition explicitly is friendlier.
  const userVenv = venvPython();
  if (existsSync(userVenv)) return userVenv;

  const devVenv = join(packageDir, 'python', '.venv', 'bin', 'python');
  if (existsSync(devVenv)) return devVenv;

  // Also try the legacy bin/python (older venv shapes had no .venv layer)
  // for back-compat with hand-rolled dev installs.
  const legacyDevBin = join(bundledPythonDir(), 'bin', 'python');
  if (existsSync(legacyDevBin)) return legacyDevBin;

  throw new Error(
    'No Python venv found. distill needs a venv at ' +
      userVenv +
      ' (created by first-launch setup) or in the dev tree. ' +
      'Open the app to run setup, or recreate the dev venv if you are running from source.',
  );
}

// ---------------------------------------------------------------------------
// doSummarise
// ---------------------------------------------------------------------------

export async function doSummarise(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'summarise');
  const row = ctx.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.transcript_text) throw new Error('Cannot summarise without a transcript');
  if (!row.meeting_type_id) throw new Error('Cannot summarise without a meeting type');

  const meetingType = ctx.state.getMeetingType(row.meeting_type_id);
  if (!meetingType) throw new Error(`Meeting type ${row.meeting_type_id} no longer exists`);

  const cfg = ctx.getConfig();

  // Pre-flight token budget check. Ollama silently truncates inputs
  // that exceed num_ctx, producing summaries missing the start of the
  // meeting. We can't prevent the truncation here (without splitting
  // the transcript and merging — see the BACKLOG history; that path
  // was deliberately not taken in favour of bumping num_ctx and
  // surfacing a warning instead). What we CAN do is record whether
  // the row submitted over budget so the inbox can show a yellow
  // "summary may be missing detail" badge on the completed row.
  const budget = estimateTokenBudget(
    meetingType.prompt,
    row.transcript_text,
    cfg.ollama.contextWindow,
  );
  if (budget.exceedsBudget) {
    ctx.logger.warn(
      {
        id,
        estimatedInputTokens: budget.estimatedInputTokens,
        budget: budget.budget,
        contextWindow: budget.contextWindow,
        overshoot: budget.estimatedInputTokens - budget.budget,
      },
      'transcript + prompt likely to exceed Ollama context budget; summary may be truncated',
    );
  }

  ctx.logger.info(
    { id, model: cfg.ollama.model, transcriptChars: row.transcript_text.length, estimatedInputTokens: budget.estimatedInputTokens },
    'starting summarisation',
  );

  let response;
  try {
    response = await ctx.ollama.chat(
      {
        model: cfg.ollama.model,
        messages: [
          { role: 'system', content: meetingType.prompt },
          { role: 'user', content: row.transcript_text },
        ],
        think: false,
        keep_alive: cfg.ollama.keepAlive,
        options: {
          num_ctx: cfg.ollama.contextWindow,
          temperature: cfg.ollama.temperature,
        },
      },
      signal,
    );
  } catch (e) {
    if (isCancelled(e)) throw new CancelledError('summarise');
    throw e;
  }

  const summary = response.message.content.trim();
  if (summary.length === 0) throw new Error('Ollama returned an empty summary');

  ctx.state.setStatus(id, 'summarising', {
    summary_text: summary,
    prompt_snapshot: meetingType.prompt,
    model_snapshot: response.model,
    truncation_warning: budget.exceedsBudget ? 1 : 0,
    estimated_input_tokens: budget.estimatedInputTokens,
    context_window_at_submit: budget.contextWindow,
  });
  ctx.logger.info({ id, chars: summary.length, truncationWarning: budget.exceedsBudget }, 'summarisation complete');
}

// ---------------------------------------------------------------------------
// doWriteOutputs — fan out to every enabled destination that hasn't yet
// succeeded. See DECISIONS.md §1 for the full per-destination idempotency
// contract.
// ---------------------------------------------------------------------------

/**
 * Runs every enabled output destination whose `*_written_at` timestamp
 * is null. Destinations with a non-null timestamp are considered already
 * landed from a prior attempt and are skipped — this is what gives the
 * step retry-idempotency without needing writers themselves to be
 * upsert-capable (which Apple Notes isn't).
 *
 * On successful destinations, the corresponding `*_written_at` is set.
 * The matching path/id column (`markdown_path` etc.) is set only when
 * THIS call wrote it; a prior-run value is preserved by never patching
 * the column to null.
 *
 * Failure semantics:
 *
 *   - All enabled-and-unwritten destinations succeed this call: row goes
 *     to complete (by the worker), error cleared.
 *   - All enabled destinations already written (nothing to do): no-op,
 *     row goes to complete. This happens on retry after everything had
 *     already landed but, say, the final state transition got lost.
 *   - Some succeed, some fail: step throws so the worker marks the row
 *     as `error`. The successful destinations' timestamps persist, so a
 *     subsequent retry will only re-run the failed ones.
 *   - All attempted destinations fail: step throws.
 *   - Zero destinations enabled: step throws — user needs to open
 *     Settings and enable one.
 */
export async function doWriteOutputs(
  id: string,
  signal: AbortSignal,
  ctx: PipelineContext,
): Promise<void> {
  throwIfAborted(signal, 'write');
  const row = ctx.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.summary_text) throw new Error('Cannot write outputs without a summary');

  const outputs = ctx.getConfig().outputs;
  if (
    !outputs.markdown.enabled &&
    !outputs.html.enabled &&
    !outputs.appleNotes.enabled
  ) {
    throw new Error(
      'No output destinations are enabled. Open Settings and turn on at least one of Markdown, HTML, or Apple Notes.',
    );
  }

  // Destinations already landed in a prior attempt — skip re-running them.
  const skip: SkipDestinations = {
    markdown: row.markdown_written_at !== null,
    html: row.html_written_at !== null,
    appleNotes: row.apple_note_written_at !== null,
  };

  // If every enabled destination has already been written, there's
  // nothing to do this call. Fall through to state-writing with empty
  // attempted/success counts; the worker will still transition the row
  // to `complete`. This path is how the "regenerate outputs" action
  // (future work, see BACKLOG) would behave if nothing had been cleared.
  const result = await writeOutputs(row, outputs, ctx.logger, skip);

  // Compose the patch carefully: we only set `*_path` / `*_id` / `*_written_at`
  // for destinations that THIS call wrote. Destinations from prior
  // attempts keep their existing row values untouched (we don't pass
  // their fields in the patch at all, rather than passing the prior
  // values back through — either works, this is simpler).
  const now = Date.now();
  const patch: WriteStepPatch = {};
  if (result.markdownPath !== null) {
    patch.markdown_path = result.markdownPath;
    patch.markdown_written_at = now;
  }
  if (result.htmlPath !== null) {
    patch.html_path = result.htmlPath;
    patch.html_written_at = now;
  }
  if (result.appleNoteId !== null) {
    patch.apple_note_id = result.appleNoteId;
    patch.apple_note_written_at = now;
  }

  // Failure handling happens after we persist partial success so no
  // work is lost. If anything failed, throw — the worker will mark the
  // row as `error` with the prettified message. On retry, the failed
  // destinations will run again; the just-persisted successes will be
  // skipped via their timestamps.
  if (result.failures.length > 0) {
    // Still persist the partial successes from this call so they're
    // locked in for the retry.
    if (Object.keys(patch).length > 0) {
      ctx.state.setStatus(id, 'writing', patch);
    }
    const msg = result.failures
      .map((f) => `${f.destination}: ${f.message}`)
      .join('; ');
    throw new Error(
      result.successCount === 0
        ? `All output destinations failed. ${msg}`
        : `Partial output failure (${result.successCount}/${result.attemptedCount} attempted succeeded this run). ${msg}`,
    );
  }

  // All-good path: clear any lingering error from a prior attempt so the
  // row's error column doesn't falsely persist past a successful retry.
  patch.error = null;
  ctx.state.setStatus(id, 'writing', patch);

  ctx.logger.info(
    {
      id,
      attempted: result.attemptedCount,
      succeeded: result.successCount,
      skippedAsAlreadyWritten: {
        markdown: skip.markdown,
        html: skip.html,
        appleNotes: skip.appleNotes,
      },
      markdownPath: result.markdownPath,
      htmlPath: result.htmlPath,
      appleNoteId: result.appleNoteId,
    },
    'outputs written',
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function throwIfAborted(signal: AbortSignal, step: string): void {
  if (signal.aborted) throw new CancelledError(step);
}
