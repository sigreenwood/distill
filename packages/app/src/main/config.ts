import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appSupportDir, configFile, expandHome } from './paths.js';
import { normalisePause, type PauseConfig } from './pause.js';

export interface OllamaConfig {
  host: string;
  model: string;
  contextWindow: number;
  temperature: number;
  keepAlive: string;
}

/**
 * Markdown file output settings. `dir` is always stored as an absolute
 * path after normaliseConfig has expanded ~ / $HOME.
 */
export interface MarkdownOutputConfig {
  enabled: boolean;
  dir: string;
  /** Embed full transcript below the summary in the .md file. */
  includeTranscript: boolean;
}

/**
 * HTML file output settings. Independent of markdown so the user can
 * enable one, the other, or both, and point them at different folders
 * (e.g. a Sync'd iCloud folder for one, a local archive for the other).
 */
export interface HtmlOutputConfig {
  enabled: boolean;
  dir: string;
  /** Embed full transcript below the summary in the .html file. */
  includeTranscript: boolean;
}

/**
 * Apple Notes output settings. Notes are written into:
 *   <parentFolder> / <client name> / <the note>
 * The parent folder and any needed client subfolder are created if
 * they don't yet exist.
 */
export interface AppleNotesOutputConfig {
  enabled: boolean;
  /** Name of the top-level folder in Notes.app. Default: "distill". */
  parentFolder: string;
  /** Embed full transcript below the summary in the note. */
  includeTranscript: boolean;
}

export interface OutputsConfig {
  markdown: MarkdownOutputConfig;
  html: HtmlOutputConfig;
  appleNotes: AppleNotesOutputConfig;
}

export interface AppConfig {
  version: number;
  ollama: OllamaConfig;
  pollIntervalMinutes: number;
  /**
   * Master + per-step pause flags. See `pause.ts` for the full shape.
   *
   * Back-compat: an older config layout had a single `paused: boolean`.
   * `loadConfig` accepts either shape on read; saves always write the
   * object form. See `normalisePause`.
   */
  paused: PauseConfig;
  whisperModel: string;
  /**
   * @deprecated Kept for back-compat with pre-outputs configs. Read
   * only by normaliseConfig to seed outputs.markdown.dir when no
   * `outputs` block is present. New code should use `outputs.markdown.dir`.
   */
  markdownBaseDir?: string;
  outputs: OutputsConfig;
  /**
   * Days after a row's most-recent successful output write before its
   * audio file becomes eligible for deletion. Only applies to
   * locally-imported rows (`source: 'local'`); Plaud-sourced audio is
   * never auto-deleted because it can be re-fetched.
   *
   * Semantics:
   *   - `null` (or missing): never sweep. Audio kept forever.
   *   - `0`: delete as soon as the row enters complete/skipped status.
   *   - positive integer: delete N days after the most recent
   *     `*_written_at` timestamp on the row.
   *   - negative: treated as `null` (logged as a warning at load time).
   */
  audioRetentionDays: number | null;
  /**
   * Auto-dismiss completed recordings from the inbox after this many
   * minutes. Set to 0 (or a negative number) to disable.
   */
  autoDismissCompleteMinutes: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
}

export class ConfigMissingError extends Error {
  constructor(public expectedPath: string, public examplePath: string) {
    super(
      `Config file not found at ${expectedPath}. ` +
      `An example has been placed next to it at ${examplePath}. ` +
      `Copy it to config.json and edit before restarting.`
    );
    this.name = 'ConfigMissingError';
  }
}

/**
 * Load config.json from Application Support. On first run, when no
 * config exists yet, copy the bundled `example.config.json` to the
 * expected location and proceed normally rather than aborting. This
 * lets fresh installs land directly in the app — they sign in via
 * Settings → Sources, and any other config tweaks happen via the
 * Settings panes too. Pre-Sources installs that hit this path needed
 * to hand-edit the file before launching; that requirement is gone.
 *
 * If the bundled example is also missing (something has gone wrong
 * with packaging) we still throw `ConfigMissingError` so the caller
 * can surface a real error to the user.
 */
export function loadConfig(resourcesDir: string): AppConfig {
  const path = configFile();
  mkdirSync(appSupportDir(), { recursive: true });

  if (!existsSync(path)) {
    const bundledExample = join(resourcesDir, 'example.config.json');
    if (!existsSync(bundledExample)) {
      // Packaging is broken: there's no example to bootstrap from.
      // Fall back to the original error so the user sees a clear
      // message rather than a silent crash. The examplePath in the
      // error is where the example WOULD have been copied; the
      // welcome dialog uses it for context.
      const examplePath = join(appSupportDir(), 'example.config.json');
      throw new ConfigMissingError(path, examplePath);
    }
    // Bootstrap: use the bundled example as the live config. The
    // user is now ready to launch normally; sign-in happens in
    // Sources, output destinations and prompts in their own panes.
    copyFileSync(bundledExample, path);
  }

  const raw = readFileSync(path, 'utf-8');
  // Cast to `unknown` then `Partial<AppConfig>` because the on-disk shape
  // can legitimately differ from AppConfig: legacy `paused: true|false`,
  // legacy `markdownBaseDir`, missing fields, hand-edited typos. Each
  // field's normaliser tolerates the actual JSON values; the cast lets
  // us reach those normalisers without TypeScript flagging the legacy
  // shapes as type errors.
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  return normaliseConfig(parsed);
}

/**
 * Fill in defaults, expand ~ to $HOME in folder paths, migrate old shapes.
 *
 * Migrations handled here:
 *   - `markdownBaseDir` (pre-outputs layout) → `outputs.markdown.dir`,
 *     with outputs.markdown.enabled=true preserving previous behaviour.
 *   - Missing `outputs` section → sensible defaults: markdown on, HTML
 *     off, Apple Notes off, transcript embedded.
 *   - Missing `autoDismissCompleteMinutes` → 10.
 */
export function normaliseConfig(cfg: Partial<AppConfig>): AppConfig {
  const defaultMarkdownDir = expandHome(
    cfg.outputs?.markdown?.dir ?? cfg.markdownBaseDir ?? '~/Documents/distill',
  );

  // Back-compat: an earlier config layout had a single `outputs.includeTranscript`.
  // If the new per-destination field is missing, use the old global as the
  // default so upgraders don't lose their previous preference. Falls back
  // to `true` for a brand-new install (original behaviour: transcript
  // embedded everywhere).
  const legacyGlobalIncludeTranscript = (cfg.outputs as { includeTranscript?: boolean } | undefined)
    ?.includeTranscript;
  const defaultIncludeTranscript = legacyGlobalIncludeTranscript ?? true;

  const outputs: OutputsConfig = {
    markdown: {
      enabled: cfg.outputs?.markdown?.enabled ?? true,
      dir: defaultMarkdownDir,
      includeTranscript:
        cfg.outputs?.markdown?.includeTranscript ?? defaultIncludeTranscript,
    },
    html: {
      enabled: cfg.outputs?.html?.enabled ?? false,
      dir: expandHome(cfg.outputs?.html?.dir ?? defaultMarkdownDir),
      includeTranscript:
        cfg.outputs?.html?.includeTranscript ?? defaultIncludeTranscript,
    },
    appleNotes: {
      enabled: cfg.outputs?.appleNotes?.enabled ?? false,
      parentFolder: cfg.outputs?.appleNotes?.parentFolder ?? 'distill',
      includeTranscript:
        cfg.outputs?.appleNotes?.includeTranscript ?? defaultIncludeTranscript,
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
          contextWindow:
            cfg.ollama.contextWindow === 32768 ? 65536 : cfg.ollama.contextWindow,
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
      typeof cfg.autoDismissCompleteMinutes === 'number'
        ? cfg.autoDismissCompleteMinutes
        : 10,
    logLevel: cfg.logLevel ?? 'info',
  };
}

/**
 * Coerce a raw `audioRetentionDays` value into the permitted shape.
 * See AppConfig.audioRetentionDays for the semantics.
 *
 * Lenient on hand-edited config: anything weird (string, NaN, negative)
 * coerces to null ("never sweep") rather than throwing. The audio sweep
 * is opt-in and getting it wrong should fail safe by keeping audio,
 * not by deleting it.
 */
function normaliseAudioRetentionDays(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  // Floor to integer days. "7.5 days" doesn't have meaningful resolution
  // for this feature; rounding down errs on the side of keeping audio.
  return Math.floor(raw);
}

/**
 * Write config back to disk. Used when the Settings window saves changes.
 * The old `markdownBaseDir` field is NOT written on save — the outputs
 * block is the new source of truth. Old installs keep working because
 * loadConfig migrates on read.
 */
export function saveConfig(cfg: AppConfig): void {
  const path = configFile();
  mkdirSync(dirname(path), { recursive: true });

  // Strip the deprecated field if it's still hanging around; write the
  // new shape only.
  const { markdownBaseDir: _drop, ...toWrite } = cfg;
  writeFileSync(path, JSON.stringify(toWrite, null, 2) + '\n', 'utf-8');
}
