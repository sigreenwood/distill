import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appSupportDir, configFile, expandHome } from './paths.js';
import { recommendModelForRam, recommendContextWindow } from './modelAdvisor.js';
import type { ProcessingSchedule, ProcessingScheduleMode } from './processingSchedule.js';

export type PausableStep = 'polling' | 'download' | 'transcribe' | 'summarise';

export const PAUSABLE_STEPS: PausableStep[] = [
  'polling',
  'download',
  'transcribe',
  'summarise',
];

export interface PauseConfig {
  all: boolean;
  polling: boolean;
  download: boolean;
  transcribe: boolean;
  summarise: boolean;
}

export interface OutputConfig {
  enabled: boolean;
  dir: string;
  includeTranscript: boolean;
}

export interface AppleNotesConfig {
  enabled: boolean;
  parentFolder: string;
  includeTranscript: boolean;
}

export interface OutputsConfig {
  markdown: OutputConfig;
  html: OutputConfig;
  appleNotes: AppleNotesConfig;
}

export interface OllamaConfig {
  host: string;
  model: string;
  contextWindow: number;
  /**
   * When true (the default), num_ctx for a summarise call is sized to
   * what that transcript actually needs (rounded up, capped at
   * contextWindow) instead of always allocating the full configured
   * ceiling's KV cache — see computeAdaptiveContextWindow in
   * tokenBudget.ts. contextWindow itself is never rewritten either way;
   * this only changes how it's used at call time. Turning this off
   * restores the old always-allocate-the-ceiling behaviour, for anyone
   * who'd rather have one predictable number than a variable one.
   */
  adaptiveContextWindow: boolean;
  temperature: number;
  keepAlive: string;
}

export interface AppConfig {
  version: number;
  ollama: OllamaConfig;
  pollIntervalMinutes: number;
  paused: PauseConfig;
  whisperModel: string;
  /**
   * Which ASR engine transcribes recordings. 'parakeet' is much faster but
   * has no prompt/hotword mechanism — vocabulary hints and pasted meeting
   * attendees don't bias it, only the post-transcription find-and-replace
   * rules still apply. Opt-in for exactly that reason; see Settings ->
   * Performance and doTranscribe in pipelineSteps.ts.
   */
  transcriptionEngine: 'whisper' | 'parakeet';
  parakeetModel: string;
  outputs: OutputsConfig;
  /** null = keep audio forever; otherwise days to keep downloaded audio */
  audioRetentionDays: number | null;
  autoDismissCompleteMinutes: number;
  /**
   * How many of the most recent recordings land in the inbox on the very
   * first poll of a fresh install; the rest of the back catalogue is
   * skipped. 0 = skip everything (the original behaviour).
   *
   * Provisional default of 10 — enough to tag and exercise the pipeline
   * without drowning the inbox. See the "first-poll catch-up" question in
   * BACKLOG; settle on a final value before a wider release.
   */
  initialPollInboxCount: number;
  logLevel: string;
  /**
   * When new work may be claimed at all — see evaluateSchedule in
   * processingSchedule.ts. Defaults to 'immediate' (the original
   * behaviour, unchanged): tagging a recording starts it right away.
   * An urgent-flagged recording (recordings.urgent) always bypasses this.
   */
  processingSchedule: ProcessingSchedule;
  /**
   * File "Queue all" recordings without waiting in Ready to file when the
   * classifier is highly confident and the calendar agrees (autoFileDecision
   * in shared/filing.ts). Off by default: filing stays a suggestion unless
   * the user opts in (DECISIONS.md §5).
   */
  autoFileHighConfidence: boolean;
  /**
   * Plaud recordings shorter than this many minutes are hidden on arrival
   * and by "Queue all" instead of being processed (pocket dials, false
   * starts). 0 keeps everything. Dragged-in files are never skipped.
   */
  minRecordingMinutes: number;
}

export function defaultPauseConfig(): PauseConfig {
  return {
    all: false,
    polling: false,
    download: false,
    transcribe: false,
    summarise: false,
  };
}

export function normalisePause(raw: unknown): PauseConfig {
  if (raw === true) return { ...defaultPauseConfig(), all: true };
  if (raw === false || raw == null) return defaultPauseConfig();
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultPauseConfig();
  }
  const obj = raw as Record<string, unknown>;
  const bool = (k: string) => obj[k] === true;
  return {
    all: bool('all'),
    polling: bool('polling'),
    download: bool('download'),
    transcribe: bool('transcribe'),
    summarise: bool('summarise'),
  };
}

export function shouldRunStep(cfg: PauseConfig, step: PausableStep): boolean {
  if (cfg.all) return false;
  return !cfg[step];
}

export function defaultProcessingSchedule(): ProcessingSchedule {
  return { mode: 'immediate', idleMinutes: 15, overnightStart: '22:00', overnightEnd: '06:00' };
}

const HM_RE = /^\d{1,2}:\d{2}$/;

export function normaliseProcessingSchedule(raw: unknown): ProcessingSchedule {
  const fallback = defaultProcessingSchedule();
  if (!raw || typeof raw !== 'object') return fallback;
  const obj = raw as Record<string, unknown>;
  const mode: ProcessingScheduleMode =
    obj.mode === 'idle' || obj.mode === 'overnight' ? obj.mode : 'immediate';
  const idleMinutes =
    typeof obj.idleMinutes === 'number' && Number.isFinite(obj.idleMinutes) && obj.idleMinutes > 0
      ? Math.floor(obj.idleMinutes)
      : fallback.idleMinutes;
  const overnightStart =
    typeof obj.overnightStart === 'string' && HM_RE.test(obj.overnightStart) ? obj.overnightStart : fallback.overnightStart;
  const overnightEnd =
    typeof obj.overnightEnd === 'string' && HM_RE.test(obj.overnightEnd) ? obj.overnightEnd : fallback.overnightEnd;
  return { mode, idleMinutes, overnightStart, overnightEnd };
}

export function pausedSteps(cfg: PauseConfig): PausableStep[] {
  if (cfg.all) return [...PAUSABLE_STEPS];
  return PAUSABLE_STEPS.filter((s) => cfg[s]);
}

const STATUS_LABEL: Record<PausableStep, string> = {
  polling: 'polling',
  download: 'downloads',
  transcribe: 'transcribe',
  summarise: 'summarise',
};

export function formatPauseStatus(cfg: PauseConfig): string | null {
  if (cfg.all) return 'Paused';
  const steps = pausedSteps(cfg);
  if (steps.length === 0) return null;
  if (steps.length === 1) return `Paused (${STATUS_LABEL[steps[0]]})`;
  return `Paused (${steps.map((s) => STATUS_LABEL[s]).join(', ')})`;
}

export class ConfigMissingError extends Error {
  expectedPath: string;
  examplePath: string;

  constructor(expectedPath: string, examplePath: string) {
    super(
      `Config file not found at ${expectedPath}. An example has been placed next to it at ${examplePath}. Copy it to config.json and edit before restarting.`,
    );
    this.expectedPath = expectedPath;
    this.examplePath = examplePath;
    this.name = 'ConfigMissingError';
  }
}

export function loadConfig(resourcesDir: string): AppConfig {
  const file = configFile();
  fs.mkdirSync(appSupportDir(), { recursive: true });
  if (!fs.existsSync(file)) {
    const bundledExample = path.join(resourcesDir, 'example.config.json');
    if (!fs.existsSync(bundledExample)) {
      const examplePath = path.join(appSupportDir(), 'example.config.json');
      throw new ConfigMissingError(file, examplePath);
    }
    fs.copyFileSync(bundledExample, file);
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const parsed = JSON.parse(raw);
  return normaliseConfig(parsed);
}

export function normaliseConfig(cfg: any): AppConfig {
  const defaultMarkdownDir = expandHome(
    cfg.outputs?.markdown?.dir ?? cfg.markdownBaseDir ?? '~/Documents/distill',
  );
  const legacyGlobalIncludeTranscript: boolean | undefined = cfg.outputs?.includeTranscript;
  const defaultIncludeTranscript = legacyGlobalIncludeTranscript ?? true;
  const outputs: OutputsConfig = {
    markdown: {
      enabled: cfg.outputs?.markdown?.enabled ?? true,
      dir: defaultMarkdownDir,
      includeTranscript: cfg.outputs?.markdown?.includeTranscript ?? defaultIncludeTranscript,
    },
    html: {
      enabled: cfg.outputs?.html?.enabled ?? false,
      dir: expandHome(cfg.outputs?.html?.dir ?? defaultMarkdownDir),
      includeTranscript: cfg.outputs?.html?.includeTranscript ?? defaultIncludeTranscript,
    },
    appleNotes: {
      enabled: cfg.outputs?.appleNotes?.enabled ?? false,
      parentFolder: cfg.outputs?.appleNotes?.parentFolder ?? 'distill',
      includeTranscript: cfg.outputs?.appleNotes?.includeTranscript ?? defaultIncludeTranscript,
    },
  };
  return {
    version: cfg.version ?? 1,
    ollama: {
      host: cfg.ollama?.host ?? 'http://localhost:11434',
      // Fresh installs get a model sized to this Mac's unified memory
      // (48GB → 35B, 24GB → 27B, 16GB → 9B, below → 4B). A model already
      // written in config.json always wins — this only fills the gap.
      model: cfg.ollama?.model ?? recommendModelForRam(os.totalmem()).model,
      contextWindow: resolveContextWindow(cfg.ollama?.contextWindow, os.totalmem()),
      adaptiveContextWindow:
        typeof cfg.ollama?.adaptiveContextWindow === 'boolean' ? cfg.ollama.adaptiveContextWindow : true,
      // Zero, deliberately. Summarising a meeting is an extraction task,
      // not a creative one: the same transcript should give the same
      // answer twice. Measured on a real 4,670-token meeting, same model,
      // same prompt:
      //   temperature 0.3 — 4 runs agreed on 18% of named entities, 58%
      //                     appeared in exactly one run, length ranged
      //                     464-638 words, and half the runs abandoned
      //                     the prompt's section structure entirely.
      //   temperature 0   — 3 runs byte-identical, all 8 prompt sections
      //                     present, action and sentiment formats correct.
      // Sampling was the entire source of that variance; the prompt was
      // never the problem. Raise this only if you actually want variety.
      temperature: cfg.ollama?.temperature ?? 0,
      // 30 minutes. The old 5-minute default was calibrated for a ~20GB
      // resident model, where holding it through idle daytime hours was
      // the difference between a usable laptop and a swapping one. The
      // recommended models are now sized to leave ~8GB clear (7GB on a
      // 24GB Mac), so holding one costs little and reloading it on every
      // meeting costs a chunk of each run. Lower this if you deliberately
      // run a model too large for the machine.
      keepAlive: cfg.ollama?.keepAlive ?? '30m',
    },
    pollIntervalMinutes: cfg.pollIntervalMinutes ?? 5,
    paused: normalisePause(cfg.paused),
    whisperModel: cfg.whisperModel ?? 'mlx-community/whisper-large-v3-mlx',
    transcriptionEngine: cfg.transcriptionEngine === 'parakeet' ? 'parakeet' : 'whisper',
    parakeetModel: cfg.parakeetModel ?? 'mlx-community/parakeet-tdt-0.6b-v3',
    outputs,
    audioRetentionDays: normaliseAudioRetentionDays(cfg.audioRetentionDays),
    autoDismissCompleteMinutes:
      typeof cfg.autoDismissCompleteMinutes === 'number' ? cfg.autoDismissCompleteMinutes : 10,
    initialPollInboxCount: normaliseInitialPollInboxCount(cfg.initialPollInboxCount),
    logLevel: cfg.logLevel ?? 'info',
    processingSchedule: normaliseProcessingSchedule(cfg.processingSchedule),
    autoFileHighConfidence: cfg.autoFileHighConfidence === true,
    minRecordingMinutes: normaliseMinRecordingMinutes(cfg.minRecordingMinutes),
  };
}

/**
 * Resolve the Ollama context window, honouring an explicit setting but
 * defaulting to what this Mac's memory can actually sustain.
 *
 * History: an early version bumped any config carrying the old 32k
 * default up to 64k, because long meetings were exceeding 32k and being
 * silently truncated. That was written on a 48GB M4 and is right there.
 * On a 24GB Mac it is actively harmful — a 27B model's weights plus a
 * 64k KV cache exceed unified memory, and Ollama dies mid-request with
 * a bare "fetch failed". Worse, because the bump keyed on the exact
 * value 32768, setting 32k by hand silently became 64k again: the
 * setting could not be fixed by the user.
 *
 * The bump now applies only where the memory supports it. Any other
 * explicit value is passed through untouched — a small model with a
 * large context is a perfectly reasonable combination we shouldn't
 * second-guess.
 */
export function resolveContextWindow(raw: unknown, totalRamBytes: number): number {
  const recommended = recommendContextWindow(totalRamBytes);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return recommended;
  if (raw === 32768 && recommended > 32768) return 65536;
  return raw;
}

function normaliseInitialPollInboxCount(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 10;
  return Math.floor(raw);
}

function normaliseAudioRetentionDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return Math.floor(raw);
}

export const MAX_MIN_RECORDING_MINUTES = 120;

export function normaliseMinRecordingMinutes(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_MIN_RECORDING_MINUTES ? v : 0;
}

export function saveConfig(cfg: AppConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // markdownBaseDir is the pre-outputs legacy key; never write it back
  const { markdownBaseDir: _drop, ...toWrite } = cfg as AppConfig & { markdownBaseDir?: string };
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
}
