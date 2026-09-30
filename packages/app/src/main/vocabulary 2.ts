/**
 * Vocabulary loader.
 *
 * Reads vocabulary JSON files from the user's appSupportDir/vocabulary/
 * and merges them into (a) a Whisper `initial_prompt` string used at
 * transcription time, and (b) a list of replacement rules applied
 * between transcription and summarisation.
 *
 * On first launch, `migrateVocabularyToUserDir` copies bundled
 * placeholder files from inside the .app into the user dir; after
 * that, all reads and writes go through the user dir. This is a
 * change from earlier shapes that read/wrote inside the .app's
 * Resources/, which is read-only on signed/quarantined installs and
 * gets blown away on every reinstall.
 *
 * File layout (after first-launch migration):
 *   ~/Library/Application Support/<app>/vocabulary/
 *     global.json           ← always applied
 *     organisation.json     ← always applied
 *     industry.json         ← always applied
 *     <client-id>.json      ← applied only when tagged to that client
 *
 * Built-in scope IDs (global, organisation, industry) ship as empty
 * placeholder files in fresh packaged installs. Users either type
 * into them directly via Settings -> Vocabulary, or import a JSON
 * file via the import button.
 *
 * On upgrade from a pre-rename install, `migrateScopeRenames` renames
 * any teradata.json -> organisation.json and ai.json -> industry.json
 * in the user dir. See that function for behaviour when both names
 * exist.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';

export interface ReplacementRule {
  /** Text to match (case-insensitive, word-boundary-matched). */
  from: string;
  /** Replacement text. */
  to: string;
  /**
   * Optional: only apply when at least one of these words appears elsewhere
   * in the transcript. Useful for homophones like "sim" → "CIM" that only
   * apply in marketing contexts.
   */
  requiresContext?: string[];
}

export interface VocabularyFile {
  $description?: string;
  $version?: number;
  whisperHints?: string[];
  replacements?: ReplacementRule[];
  notes?: string[];
}

export interface Vocabulary {
  /**
   * Ready-to-use Whisper initial_prompt, truncated to a reasonable length
   * (Whisper's own prompt window is ~200-240 tokens, so we cap around
   * 1000 characters to stay under that).
   */
  whisperPrompt: string;
  /** De-duplicated, in priority order (client rules first). */
  replacements: ReplacementRule[];
  /** Which vocabulary files contributed to this merged result. */
  sources: string[];
}

// Whisper's prompt window is approximately 224 tokens. With chars/4
// as a rough proxy that's about 900 chars; we use 800 as a margin to
// keep us comfortably under the truncation cliff. Going over the
// window doesn't error — Whisper silently drops the END of the prompt,
// which is why hint ordering below puts hints first and the preamble
// second. Anything that gets dropped on a too-long prompt is the
// preamble, which is recoverable; we never want to drop hints.
const WHISPER_PROMPT_CHAR_LIMIT = 800;

export function loadVocabulary(vocabularyDir: string, clientId: string | null): Vocabulary {
  const sources: string[] = [];
  const hints: string[] = [];
  const replacements: ReplacementRule[] = [];

  const files = ['global.json', 'organisation.json', 'industry.json'];
  if (clientId) files.push(`${clientId}.json`);

  for (const filename of files) {
    const path = join(vocabularyDir, filename);
    if (!existsSync(path)) continue;

    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as VocabularyFile;
      if (data.whisperHints) hints.push(...data.whisperHints);
      if (data.replacements) replacements.push(...data.replacements);
      sources.push(filename);
    } catch (e) {
      throw new Error(
        `Invalid vocabulary file ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const uniqueHints = Array.from(new Set(hints));
  const whisperPrompt = buildWhisperPrompt(uniqueHints);

  return { whisperPrompt, replacements, sources };
}

export function listVocabularyFiles(vocabularyDir: string): string[] {
  if (!existsSync(vocabularyDir)) return [];
  return readdirSync(vocabularyDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('$'))
    .sort();
}

function buildWhisperPrompt(hints: string[]): string {
  if (hints.length === 0) return '';

  // Order matters: hints first, preamble second.
  //
  // Whisper's prompt window is roughly 224 tokens. When the prompt
  // exceeds the window the END is silently truncated by Whisper's
  // tokeniser. If our preamble ("This is a business meeting...")
  // came first, an overlong prompt would silently drop the actual
  // domain terms we wanted to bias toward — the worst possible
  // outcome.
  //
  // Putting hints first means an overlong prompt drops the
  // boilerplate framing instead. The framing helps marginally with
  // tone/punctuation; the hints are the load-bearing part for
  // accuracy on names + acronyms.
  const trailer = '. This is a business meeting.';

  const hintList = hints.join(', ');
  const full = `${hintList}${trailer}`;
  if (full.length <= WHISPER_PROMPT_CHAR_LIMIT) return full;

  // Over the limit: greedy-pack hints up to the budget, then add the
  // trailer if there's room (and drop it cleanly if there isn't — a
  // bare comma-separated list is still a valid prompt).
  const budget = WHISPER_PROMPT_CHAR_LIMIT - trailer.length;
  const kept: string[] = [];
  let used = 0;
  for (const h of hints) {
    const cost = h.length + 2; // ', '
    if (used + cost > budget) break;
    kept.push(h);
    used += cost;
  }
  if (kept.length === 0) {
    // Pathological case — every hint individually exceeds the
    // budget. Keep the first one truncated rather than returning
    // an empty prompt; some bias is better than none.
    return hints[0]!.slice(0, WHISPER_PROMPT_CHAR_LIMIT);
  }
  const list = kept.join(', ');
  // Add the trailer if it fits; otherwise return just the list.
  if (list.length + trailer.length <= WHISPER_PROMPT_CHAR_LIMIT) {
    return `${list}${trailer}`;
  }
  return list;
}

// ---------------------------------------------------------------------------
// Single-scope read / write
//
// The Vocabulary pane in Settings edits one scope's file at a time. These
// helpers deal with a single JSON file by its scope id (= filename stem),
// as opposed to the merged-for-pipeline view that loadVocabulary returns.
// ---------------------------------------------------------------------------

/**
 * Read a single scope's vocabulary file. Returns an empty-shape
 * VocabularyFile if the file doesn't exist yet — allows the UI to
 * start editing a fresh client scope before it's ever been saved.
 * Throws on malformed JSON (same contract as loadVocabulary).
 */
export function readVocabularyFile(
  vocabularyDir: string,
  scopeId: string,
): VocabularyFile {
  const path = join(vocabularyDir, `${scopeId}.json`);
  if (!existsSync(path)) {
    return { $version: 1, whisperHints: [], replacements: [] };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as VocabularyFile;
  } catch (e) {
    throw new Error(
      `Invalid vocabulary file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Write a scope's vocabulary file atomically. Creates the vocabulary
 * directory if it doesn't yet exist. Preserves the JSON convention
 * used by the hand-authored files: 2-space indent, trailing newline.
 * Does NOT validate content — the IPC handler does shape validation
 * before calling in here.
 */
export function writeVocabularyFile(
  vocabularyDir: string,
  scopeId: string,
  file: VocabularyFile,
): void {
  mkdirSync(vocabularyDir, { recursive: true });
  const path = join(vocabularyDir, `${scopeId}.json`);
  const serialised = JSON.stringify(file, null, 2) + '\n';
  writeFileSync(path, serialised, 'utf-8');
}

/**
 * Whether a scope id is one of the always-applied built-in packs.
 * Built-ins can be edited like any other scope — this is just a
 * marker for the UI to tag them visually.
 */
export const BUILTIN_SCOPE_IDS: readonly string[] = ['global', 'organisation', 'industry'];

export function isBuiltinScopeId(scopeId: string): boolean {
  return (BUILTIN_SCOPE_IDS as readonly string[]).includes(scopeId);
}

/**
 * Rename pre-existing built-in scope files in the user dir from their
 * old IDs to the new ones. Run on every launch before any vocabulary
 * read or write so the rest of the app only ever sees the new names.
 *
 * Mappings:
 *   teradata.json -> organisation.json
 *   ai.json       -> industry.json
 *
 * Per-source behaviour:
 *   - Old file exists, new file doesn't: rename the old to the new.
 *   - Old file doesn't exist: nothing to do (this is the steady
 *     state after the first migration, AND the case for fresh
 *     installs that never had old names).
 *   - Both old and new exist: keep the new file and delete the old.
 *     This is the conservative call — if a user has somehow ended
 *     up with both, the new name was almost certainly created by
 *     the most recent app version (post-rename), so it has the
 *     fresher data. Logged so it's traceable. Could happen if
 *     someone hand-copied files between machines mid-upgrade.
 *
 * Idempotent: safe to call on every launch. Errors are caught and
 * logged — the migration must not block app start. If a rename
 * fails (e.g. permissions), the old file stays in place and the
 * pipeline reads from the new (empty) name on next transcription;
 * the user can recover by manually moving the file or re-importing
 * via Settings.
 */
export function migrateScopeRenames(
  userDir: string,
  logger?: Logger,
): { renamed: string[]; deletedDuplicates: string[] } {
  const renamed: string[] = [];
  const deletedDuplicates: string[] = [];

  if (!existsSync(userDir)) {
    // No user dir yet — nothing to migrate. The migrateVocabularyToUserDir
    // helper will create it next, populated from the (already-renamed)
    // bundled templates. So fresh installs hit this branch and exit
    // cleanly.
    return { renamed, deletedDuplicates };
  }

  const renames: Array<[string, string]> = [
    ['teradata.json', 'organisation.json'],
    ['ai.json', 'industry.json'],
  ];

  for (const [oldName, newName] of renames) {
    const oldPath = join(userDir, oldName);
    const newPath = join(userDir, newName);

    if (!existsSync(oldPath)) continue;

    if (existsSync(newPath)) {
      // Both exist. Keep the new, delete the old, log it.
      try {
        unlinkSync(oldPath);
        deletedDuplicates.push(oldName);
        logger?.warn(
          { oldName, newName, userDir },
          'vocabulary migration: both old and new scope files existed; deleted old, kept new',
        );
      } catch (e) {
        logger?.error(
          { oldName, newName, userDir, err: String(e) },
          'vocabulary migration: could not delete old scope file',
        );
      }
      continue;
    }

    // Normal case: rename.
    try {
      renameSync(oldPath, newPath);
      renamed.push(`${oldName} -> ${newName}`);
    } catch (e) {
      logger?.error(
        { oldName, newName, userDir, err: String(e) },
        'vocabulary migration: could not rename scope file',
      );
    }
  }

  if (renamed.length > 0) {
    logger?.info(
      { renamed, userDir },
      'vocabulary scope rename migration applied',
    );
  }
  return { renamed, deletedDuplicates };
}

/**
 * Copy bundled vocabulary files into the user-writable directory.
 * Idempotent: safe to call on every launch. Files that already exist
 * in the user dir are skipped (user wins).
 *
 * Errors are caught and logged — a broken vocab migration must not
 * prevent the app from starting. The pipeline tolerates missing
 * vocab files (loadVocabulary skips them), so a partial migration
 * is recoverable.
 */
export function migrateVocabularyToUserDir(
  bundledDir: string,
  userDir: string,
  logger?: Logger,
): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(bundledDir)) {
    logger?.warn(
      { bundledDir },
      'bundled vocabulary directory missing - skipping migration',
    );
    return { copied, skipped };
  }

  try {
    mkdirSync(userDir, { recursive: true });
  } catch (e) {
    logger?.error(
      { userDir, err: String(e) },
      'could not create user vocabulary directory',
    );
    return { copied, skipped };
  }

  let entries: string[];
  try {
    entries = readdirSync(bundledDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.'),
    );
  } catch (e) {
    logger?.error(
      { bundledDir, err: String(e) },
      'could not read bundled vocabulary directory',
    );
    return { copied, skipped };
  }

  for (const filename of entries) {
    const src = join(bundledDir, filename);
    const dst = join(userDir, filename);
    if (existsSync(dst)) {
      skipped.push(filename);
      continue;
    }
    try {
      copyFileSync(src, dst);
      copied.push(filename);
    } catch (e) {
      logger?.warn(
        { src, dst, err: String(e) },
        'failed to copy vocabulary file during migration',
      );
    }
  }

  if (copied.length > 0) {
    logger?.info(
      { copied, userDir },
      'vocabulary migration: copied bundled files into user dir',
    );
  }
  return { copied, skipped };
}

/**
 * Count the individually-editable rows in a vocabulary file. Used in
 * the Settings sidebar badge so the user can see at a glance which
 * scopes have content. Counts whisperHints entries plus replacement
 * rules — notes and metadata aren't counted.
 */
export function countVocabularyTerms(file: VocabularyFile): number {
  return (file.whisperHints?.length ?? 0) + (file.replacements?.length ?? 0);
}

/**
 * Characters that need escaping in a regex literal. Stored as a string
 * and rebuilt at import time to avoid repeated regex construction.
 */
const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_METACHARS, '\\$&');
}

/**
 * Apply replacement rules to a transcript.
 *
 * Matching rules:
 *   - Case-insensitive.
 *   - Won't match inside a word (e.g. "amp" won't fire inside "campfire").
 *   - Optional context gating: if `requiresContext` is set, at least one
 *     of those words must appear elsewhere in the transcript for the
 *     rule to fire. Used for homophones like "sim" → "CIM" that only
 *     apply in marketing contexts.
 *
 * Boundary handling — this is subtle:
 *
 * Plain `\b` (word boundary) only matches between a word character and
 * a non-word character. Terms like `C++` have non-word characters (`+`)
 * at their outer ends, so `\bC\+\+\b` fails because there's no
 * word↔non-word transition at the trailing `+`. The fix: build the
 * boundary explicitly based on whether the term's outer characters are
 * word or non-word.
 *
 * - Word-char outer end → anchor with `(^|\W)` / `(\W|$)` so we only
 *   match when the character just outside the term isn't a word char.
 *   Capturing group so the consumed char is re-emitted in output.
 * - Non-word-char outer end → no anchor needed. The literal non-word
 *   char at the edge is itself distinctive enough; a match inside some
 *   larger string is fine (and in practice "C++" anywhere should
 *   rewrite to "C-plus-plus" regardless of surrounding punctuation).
 *
 * Capturing groups also give us an unambiguous way to re-emit the
 * consumed boundary character — cleaner than inferring from match length
 * which can't tell `(^|...)` zero-width match from a consumed char.
 */
export function applyReplacements(transcript: string, rules: ReplacementRule[]): {
  text: string;
  applied: number;
} {
  if (!transcript || rules.length === 0) return { text: transcript, applied: 0 };

  const transcriptLower = transcript.toLowerCase();
  let text = transcript;
  let applied = 0;

  for (const rule of rules) {
    if (rule.from.length === 0) continue;

    if (rule.requiresContext && rule.requiresContext.length > 0) {
      const hasContext = rule.requiresContext.some((ctx) =>
        transcriptLower.includes(ctx.toLowerCase()),
      );
      if (!hasContext) continue;
    }

    const escaped = escapeRegex(rule.from);
    const firstChar = rule.from[0] ?? '';
    const lastChar = rule.from[rule.from.length - 1] ?? '';
    const startsWithWord = /\w/.test(firstChar);
    const endsWithWord = /\w/.test(lastChar);

    // Capturing groups — the callback receives each as a positional arg.
    // We re-emit them so no transcript characters get deleted around the
    // match.
    const leadGroup = startsWithWord ? '(^|\\W)' : '';
    const trailGroup = endsWithWord ? '(\\W|$)' : '';
    const pattern = `${leadGroup}${escaped}${trailGroup}`;
    const re = new RegExp(pattern, 'gi');

    const hasLead = startsWithWord;
    const hasTrail = endsWithWord;

    const before = text;
    text = text.replace(re, (...args: unknown[]) => {
      // String.replace callback signature with capture groups:
      //   match, p1, p2, ..., offset, fullString
      // Positional capture args are at [1 .. args.length - 2].
      const lead = hasLead ? (args[1] as string) ?? '' : '';
      const trail = hasTrail
        ? (args[hasLead ? 2 : 1] as string) ?? ''
        : '';
      return `${lead}${rule.to}${trail}`;
    });
    if (text !== before) applied++;
  }

  return { text, applied };
}
