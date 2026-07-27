import fs from 'node:fs';
import path from 'node:path';
import { appSupportDir, configFile, expandHome } from './paths.js';

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
  temperature: number;
  keepAlive: string;
}

export interface AppConfig {
  version: number;
  ollama: OllamaConfig;
  pollIntervalMinutes: number;
  paused: PauseConfig;
  whisperModel: string;
  outputs: OutputsConfig;
  /** null = keep audio forever; otherwise days to keep downloaded audio */
  audioRetentionDays: number | null;
  autoDismissCompleteMinutes: number;
  logLevel: string;
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
    ollama: cfg.ollama
      ? {
          ...cfg.ollama,
          // One-time bump of contextWindow from the old 32k default to
          // 64k, applied only when the on-disk value is exactly the old
          // default. Manually-set values (e.g. 16384 or 131072) are
          // preserved. Why bump: long meetings (~2h+) at qwen2.5:32b's
          // typical token rate were brushing or exceeding 32k, causing
          // Ollama to silently truncate the start of the input. 64k
          // gives ~6h of conversational speech of headroom against the
          // model's 131k native context. Costs ~4-6GB more unified
          // memory while the model is resident.
          contextWindow: cfg.ollama.contextWindow === 32768 ? 65536 : cfg.ollama.contextWindow,
        }
      : {
          host: 'http://localhost:11434',
          model: 'qwen2.5:32b',
          contextWindow: 65536,
          temperature: 0.3,
          // 5 minutes: long enough that back-to-back summaries reuse the
          // loaded model, short enough that idle daytime hours get the
          // ~20GB of unified memory back. See BACKLOG "Performance under
          // load" for the broader story; this default is the lowest-cost
          // single change for the laggy-laptop-during-processing problem.
          keepAlive: '5m',
        },
    pollIntervalMinutes: cfg.pollIntervalMinutes ?? 5,
    paused: normalisePause(cfg.paused),
    whisperModel: cfg.whisperModel ?? 'mlx-community/whisper-large-v3-mlx',
    outputs,
    audioRetentionDays: normaliseAudioRetentionDays(cfg.audioRetentionDays),
    autoDismissCompleteMinutes:
      typeof cfg.autoDismissCompleteMinutes === 'number' ? cfg.autoDismissCompleteMinutes : 10,
    logLevel: cfg.logLevel ?? 'info',
  };
}

function normaliseAudioRetentionDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return Math.floor(raw);
}

export function saveConfig(cfg: AppConfig): void {
  const file = configFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // markdownBaseDir is the pre-outputs legacy key; never write it back
  const { markdownBaseDir: _drop, ...toWrite } = cfg as AppConfig & { markdownBaseDir?: string };
  fs.writeFileSync(file, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
}
