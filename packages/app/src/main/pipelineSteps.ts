import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { audioDir, userVocabularyDir } from './paths.js';
import { bundledPythonDir, bundledTranscribeScript } from './bundledResources.js';
import { venvPython } from './pythonEnv.js';
import { loadVocabulary, applyReplacements } from './vocabulary.js';
import { cleanWhisperRepetitions } from './transcriptCleanup.js';
import { estimateTokenBudget, computeAdaptiveContextWindow } from './tokenBudget.js';
import { writeOutputs } from './outputs.js';
import { suggestFiling } from './filingSuggestion.js';
import { CancelledError, isCancelled, throwIfAborted } from './cancellation.js';
import type { Logger } from './logger.js';
import type { AppConfig, OutputsConfig } from './config.js';
import { effectiveOutputTargets } from './state.js';
import type { RecordingRow, State } from './state.js';
import type { OllamaClient } from './ollama.js';
import { parseStoredAttendees, buildAttendeeRoster } from '../shared/attendees.js';

/** The audio source the download step needs: just a temp-URL provider. */
export interface AudioSource {
  getMp3Url(id: string): Promise<string | null>;
}

export interface PipelineContext {
  state: State;
  logger: Logger;
  getConfig: () => AppConfig;
  plaud: AudioSource;
  ollama: OllamaClient;
  /** packages/app root in dev; used to find the dev venv. */
  packageDir: string;
  appSupportDir?: string;
  isPackaged?: boolean;
  /**
   * Seconds since the last user input, for 'idle' processingSchedule
   * mode (see Worker.loop and processingSchedule.ts). Injected rather
   * than read from Electron's powerMonitor directly, keeping this file
   * and worker.ts free of an Electron import — same reasoning as
   * getConfig being a getter instead of a plain AppConfig. Optional so
   * existing tests that construct a PipelineContext without it keep
   * working; the worker treats a missing getter as "never idle".
   */
  getSystemIdleSeconds?: () => number;
}

/**
 * Whether a recording's stored audio_path still points at a real file.
 * Used to decide whether "full re-run" can go straight to transcribe, or
 * (for Plaud recordings, which are never touched by audio retention) needs
 * to fall back to re-downloading first.
 */
export function audioFileExists(row: Pick<RecordingRow, 'audio_path'>): boolean {
  return row.audio_path !== null && fs.existsSync(row.audio_path);
}

export async function doDownload(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'download');
  const url = await ctx.plaud.getMp3Url(id);
  if (!url) throw new Error('Plaud did not return a download URL for this recording');
  const dir = audioDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${id}.mp3`);
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  ctx.logger.info({ id, dest }, 'downloading audio');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  if (!res.body) throw new Error('Download failed: empty response body');
  try {
    await streamPipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(dest), { signal });
  } catch (e) {
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
      } catch {
        // best-effort cleanup of the partial file
      }
    }
    if (isCancelled(e)) throw new CancelledError('download');
    throw e;
  }
  const size = fs.statSync(dest).size;
  if (size === 0) {
    fs.unlinkSync(dest);
    throw new Error('Downloaded file is empty');
  }
  ctx.state.setStatus(id, 'downloading', { audio_path: dest });
  ctx.logger.info({ id, bytes: size }, 'download complete');
}

interface TranscribeOutput {
  text: string;
  model: string;
  language?: string;
  vad?: {
    enabled: boolean;
    total_seconds: number;
    speech_seconds: number;
    speech_ratio: number;
    segments: number;
    removed_seconds: number;
  };
}

/**
 * The engine-specific slice of transcribe.py's CLI args — split out from
 * doTranscribe so the "parakeet never gets --initial-prompt" rule (it has
 * no prompt/hotword mechanism at all) is a pure, unit-testable function
 * rather than something buried in a much larger one.
 */
export function buildTranscribeArgs(opts: {
  engine: 'whisper' | 'parakeet';
  whisperModel: string;
  parakeetModel: string;
  initialPrompt: string | null;
}): string[] {
  if (opts.engine === 'parakeet') {
    return ['--engine', 'parakeet', '--parakeet-model', opts.parakeetModel];
  }
  const args = ['--whisper-model', opts.whisperModel];
  if (opts.initialPrompt) args.push('--initial-prompt', opts.initialPrompt);
  return args;
}

export async function doTranscribe(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'transcribe');
  const row = ctx.state.getRecording(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.audio_path) throw new Error('Cannot transcribe without an audio file');

  const attendees = parseStoredAttendees(row.attendees_json);
  const vocabularyDir = userVocabularyDir();
  const vocab = loadVocabulary(
    vocabularyDir,
    row.client_id,
    undefined,
    attendees.map((a) => a.name),
  );
  const cfg = ctx.getConfig();

  if (cfg.transcriptionEngine === 'parakeet') {
    // Hints were still computed above (needed for vocab.replacements,
    // which runs post-transcription regardless of engine) but never reach
    // the subprocess — log that plainly rather than the usual
    // hints-used/dropped breakdown, which would misleadingly imply they
    // were attempted.
    if (vocab.sources.length > 0 || attendees.length > 0) {
      ctx.logger.info(
        { id, sources: vocab.sources, attendeeNames: attendees.length, replacements: vocab.replacements.length },
        'vocabulary loaded, but hints are not used — parakeet engine has no prompt/hotword mechanism (find-and-replace rules still apply)',
      );
    }
  } else if (vocab.sources.length > 0) {
    ctx.logger.info(
      {
        id,
        sources: vocab.sources,
        hintsChars: vocab.whisperPrompt.length,
        hintsUsed: vocab.hintsUsed,
        hintsAvailable: vocab.hintsAvailable,
        replacements: vocab.replacements.length,
      },
      'vocabulary loaded',
    );
    if (vocab.hintsDropped.length > 0) {
      // Silently having no effect is the worst outcome for someone
      // curating a keyword list, so say exactly which terms were unused.
      ctx.logger.warn(
        {
          id,
          dropped: vocab.hintsDropped.length,
          examples: vocab.hintsDropped.slice(0, 10),
        },
        `vocabulary exceeds Whisper's 800-character prompt limit — ${vocab.hintsDropped.length} term(s) had no effect`,
      );
    }
    if (vocab.conflictingRules.length > 0) {
      ctx.logger.warn(
        { id, conflicts: vocab.conflictingRules },
        'vocabulary has replacement rules that rewrite the same term differently; the last one loaded wins',
      );
    }
  }

  const pyBinary = resolvePythonBinary(ctx.packageDir);
  const script = bundledTranscribeScript();
  const engineArgs = buildTranscribeArgs({
    engine: cfg.transcriptionEngine,
    whisperModel: cfg.whisperModel,
    parakeetModel: cfg.parakeetModel,
    initialPrompt: vocab.whisperPrompt || null,
  });
  const args = [script, '--audio', row.audio_path, ...engineArgs];
  ctx.logger.info(
    { id, pyBinary, engine: cfg.transcriptionEngine, model: cfg.transcriptionEngine === 'parakeet' ? cfg.parakeetModel : cfg.whisperModel },
    'starting transcription',
  );
  const proc = spawn(pyBinary, args, { signal });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
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
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(
      `Transcription output was not valid JSON. Last 500 chars of stderr: ${stderr.slice(-500)}`,
    );
  }
  if (!parsed.text || parsed.text.trim().length === 0) {
    throw new Error('Transcription produced an empty transcript');
  }

  const { text: corrected, applied } = applyReplacements(parsed.text, vocab.replacements);
  if (applied > 0) {
    ctx.logger.info(
      { id, rulesApplied: applied, totalRules: vocab.replacements.length },
      'applied vocabulary replacements',
    );
  }
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
    { id, chars: corrected.length, language: parsed.language, vad: parsed.vad ?? null },
    'transcription complete',
  );
}

export function resolvePythonBinary(packageDir: string): string {
  const userVenv = venvPython();
  if (fs.existsSync(userVenv)) return userVenv;
  const devVenv = path.join(packageDir, 'python', '.venv', 'bin', 'python');
  if (fs.existsSync(devVenv)) return devVenv;
  const legacyDevBin = path.join(bundledPythonDir(), 'bin', 'python');
  if (fs.existsSync(legacyDevBin)) return legacyDevBin;
  throw new Error(
    'No Python venv found. distill needs a venv at ' +
      userVenv +
      ' (created by first-launch setup) or in the dev tree. Open the app to run setup, or recreate the dev venv if you are running from source.',
  );
}

export async function doSummarise(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'summarise');
  const row = ctx.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.transcript_text) throw new Error('Cannot summarise without a transcript');
  const meetingTypeId =
    row.meeting_type_id ??
    (row.needs_filing === 1 ? await classifyForFiling(row, row.transcript_text, signal, ctx) : null);
  if (!meetingTypeId) throw new Error('Cannot summarise without a meeting type');
  const meetingType = ctx.state.getMeetingType(meetingTypeId);
  if (!meetingType) throw new Error(`Meeting type ${meetingTypeId} no longer exists`);

  // The attendee roster (if any) goes in the user message ahead of the
  // transcript, not the system prompt — meeting-type prompts are
  // hash-tracked for the "modified from default" badge and must stay
  // exactly what the meeting type says, independent of any one recording.
  const roster = buildAttendeeRoster(parseStoredAttendees(row.attendees_json));
  const userContent = roster ? `${roster}\n\n${row.transcript_text}` : row.transcript_text;

  const cfg = ctx.getConfig();
  const budget = estimateTokenBudget(meetingType.prompt, userContent, cfg.ollama.contextWindow);
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
  // Size the actual Ollama call to what this transcript needs rather than
  // always allocating contextWindow's full KV cache — a 10-minute meeting
  // and a 3-hour one shouldn't cost the same memory. Still bounded by
  // contextWindow: this never raises the effective limit, so the warning
  // above still fires exactly when it used to. See tokenBudget.ts.
  const numCtx = cfg.ollama.adaptiveContextWindow
    ? computeAdaptiveContextWindow(budget.estimatedInputTokens, cfg.ollama.contextWindow)
    : cfg.ollama.contextWindow;
  ctx.logger.info(
    {
      id,
      model: cfg.ollama.model,
      transcriptChars: row.transcript_text.length,
      estimatedInputTokens: budget.estimatedInputTokens,
      numCtx,
    },
    'starting summarisation',
  );
  let response;
  try {
    response = await ctx.ollama.chat(
      {
        model: cfg.ollama.model,
        messages: [
          { role: 'system', content: meetingType.prompt },
          { role: 'user', content: userContent },
        ],
        think: false,
        keep_alive: cfg.ollama.keepAlive,
        options: {
          num_ctx: numCtx,
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
  // Every summary the pipeline produces is logged as an active version —
  // see main/summaryVersions.ts. This only touches summary_versions'
  // own bookkeeping; the recordings row above is already the source of
  // truth for the live summary.
  ctx.state.addSummaryVersion({
    id: crypto.randomUUID(),
    recording_id: id,
    summary_text: summary,
    model: response.model,
    prompt_snapshot: meetingType.prompt,
    meeting_type_name: meetingType.name,
    active: true,
  });
  ctx.logger.info(
    { id, chars: summary.length, truncationWarning: budget.exceedsBudget },
    'summarisation complete',
  );
}

/**
 * Pick a client and meeting type for a "Queue all" row and record them
 * as a suggestion. The meeting type is stored on the row straight away,
 * so a retry after a failed summary doesn't classify again; the client
 * stays a suggestion until the user files it. An unparseable reply falls
 * back to the first meeting type with no client, and the Inbox says so.
 */
async function classifyForFiling(
  row: RecordingRow,
  transcript: string,
  signal: AbortSignal,
  ctx: PipelineContext,
): Promise<string | null> {
  const types = ctx.state.listMeetingTypes();
  if (types.length === 0) return null;
  const clients = ctx.state
    .listClients()
    .filter((c) => c.id !== 'unclassified')
    .map((c) => ({ id: c.id, name: c.name }));
  const cfg = ctx.getConfig();
  ctx.logger.info({ id: row.id, clients: clients.length, types: types.length }, 'classifying for filing');
  let suggestion;
  try {
    suggestion = await suggestFiling(
      { title: row.filename, durationSeconds: row.duration_seconds, transcript },
      clients,
      types,
      ctx.ollama,
      { model: cfg.ollama.model, keepAlive: cfg.ollama.keepAlive },
      signal,
    );
  } catch (e) {
    if (isCancelled(e)) throw new CancelledError('summarise');
    throw e;
  }
  const patch: Partial<RecordingRow> = suggestion
    ? {
        meeting_type_id: suggestion.meetingTypeId,
        suggested_client_id: suggestion.clientId,
        filing_confidence: suggestion.confidence,
        filing_reason: suggestion.reason,
      }
    : {
        meeting_type_id: types[0].id,
        suggested_client_id: null,
        filing_confidence: null,
        filing_reason: 'Could not classify this recording automatically.',
      };
  ctx.state.updateRecording(row.id, patch);
  ctx.logger.info(
    {
      id: row.id,
      meetingTypeId: patch.meeting_type_id,
      clientId: patch.suggested_client_id,
      confidence: patch.filing_confidence,
    },
    suggestion ? 'filing suggestion recorded' : 'filing classification unparseable; using default meeting type',
  );
  return patch.meeting_type_id ?? null;
}

export async function doWriteOutputs(id: string, signal: AbortSignal, ctx: PipelineContext): Promise<void> {
  throwIfAborted(signal, 'write');
  const row = ctx.state.getRecordingJoined(id);
  if (!row) throw new Error(`No such recording: ${id}`);
  if (!row.summary_text) throw new Error('Cannot write outputs without a summary');
  const globalOutputs = ctx.getConfig().outputs;
  const targets = effectiveOutputTargets(row, globalOutputs);
  const outputs: OutputsConfig = {
    markdown: { ...globalOutputs.markdown, enabled: targets.markdown },
    html: { ...globalOutputs.html, enabled: targets.html },
    appleNotes: { ...globalOutputs.appleNotes, enabled: targets.appleNote },
  };
  if (!outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled) {
    throw new Error(
      'No output destinations are enabled for this recording. Turn one on for this row, or in Settings → Outputs.',
    );
  }
  const skip = {
    markdown: row.markdown_written_at !== null,
    html: row.html_written_at !== null,
    appleNotes: row.apple_note_written_at !== null,
  };
  const result = await writeOutputs(row, outputs, ctx.logger, skip);
  const now = Date.now();
  const patch: Partial<RecordingRow> = {};
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
  if (result.failures.length > 0) {
    if (Object.keys(patch).length > 0) {
      ctx.state.setStatus(id, 'writing', patch);
    }
    const msg = result.failures.map((f) => `${f.destination}: ${f.message}`).join('; ');
    throw new Error(
      result.successCount === 0
        ? `All output destinations failed. ${msg}`
        : `Partial output failure (${result.successCount}/${result.attemptedCount} attempted succeeded this run). ${msg}`,
    );
  }
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
