import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.js';

const WHISPER_PROMPT_CHAR_LIMIT = 800;

export interface VocabularyReplacement {
  from: string;
  to: string;
  /** Rule only fires when at least one of these strings appears anywhere in the transcript. */
  requiresContext?: string[];
}

export interface VocabularyFile {
  $version: number;
  whisperHints: string[];
  replacements: VocabularyReplacement[];
  notes?: string[];
}

export interface LoadedVocabulary {
  whisperPrompt: string;
  replacements: VocabularyReplacement[];
  sources: string[];
}

/**
 * Merge the built-in scopes (global, organisation, industry) plus the
 * per-client file when a client id is given. Missing files are fine;
 * malformed JSON is an error the pipeline surfaces.
 */
export function loadVocabulary(vocabularyDir: string, clientId?: string | null): LoadedVocabulary {
  const sources: string[] = [];
  const hints: string[] = [];
  const replacements: VocabularyReplacement[] = [];
  const files = ['global.json', 'organisation.json', 'industry.json'];
  if (clientId) files.push(`${clientId}.json`);
  for (const filename of files) {
    const p = path.join(vocabularyDir, filename);
    if (!fs.existsSync(p)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<VocabularyFile>;
      if (data.whisperHints) hints.push(...data.whisperHints);
      if (data.replacements) replacements.push(...data.replacements);
      sources.push(filename);
    } catch (e) {
      throw new Error(`Invalid vocabulary file ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const uniqueHints = Array.from(new Set(hints));
  const whisperPrompt = buildWhisperPrompt(uniqueHints);
  return { whisperPrompt, replacements, sources };
}

/**
 * Whisper initial_prompt: a comma-separated hint list capped at 800 chars
 * (whisper truncates around 224 tokens; over-long prompts also degrade
 * accuracy). Hints are dropped from the tail when over budget.
 */
export function buildWhisperPrompt(hints: string[]): string {
  if (hints.length === 0) return '';
  const trailer = '. This is a business meeting.';
  const hintList = hints.join(', ');
  const full = `${hintList}${trailer}`;
  if (full.length <= WHISPER_PROMPT_CHAR_LIMIT) return full;
  const budget = WHISPER_PROMPT_CHAR_LIMIT - trailer.length;
  const kept: string[] = [];
  let used = 0;
  for (const h of hints) {
    const cost = h.length + 2;
    if (used + cost > budget) break;
    kept.push(h);
    used += cost;
  }
  if (kept.length === 0) {
    return hints[0].slice(0, WHISPER_PROMPT_CHAR_LIMIT);
  }
  const list = kept.join(', ');
  if (list.length + trailer.length <= WHISPER_PROMPT_CHAR_LIMIT) {
    return `${list}${trailer}`;
  }
  return list;
}

export function readVocabularyFile(vocabularyDir: string, scopeId: string): VocabularyFile {
  const p = path.join(vocabularyDir, `${scopeId}.json`);
  if (!fs.existsSync(p)) {
    return { $version: 1, whisperHints: [], replacements: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as VocabularyFile;
  } catch (e) {
    throw new Error(`Invalid vocabulary file ${p}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function writeVocabularyFile(
  vocabularyDir: string,
  scopeId: string,
  file: VocabularyFile,
): void {
  fs.mkdirSync(vocabularyDir, { recursive: true });
  const p = path.join(vocabularyDir, `${scopeId}.json`);
  const serialised = JSON.stringify(file, null, 2) + '\n';
  fs.writeFileSync(p, serialised, 'utf-8');
}

export const BUILTIN_SCOPE_IDS = ['global', 'organisation', 'industry'] as const;

export function isBuiltinScopeId(scopeId: string): boolean {
  return (BUILTIN_SCOPE_IDS as readonly string[]).includes(scopeId);
}

/**
 * One-time rename of contributor-specific scope files to the generic
 * names ("teradata" -> "organisation", "ai" -> "industry"). If both old
 * and new exist, the new one wins and the old is deleted.
 */
export function migrateScopeRenames(
  userDir: string,
  logger?: Logger,
): { renamed: string[]; deletedDuplicates: string[] } {
  const renamed: string[] = [];
  const deletedDuplicates: string[] = [];
  if (!fs.existsSync(userDir)) {
    return { renamed, deletedDuplicates };
  }
  const renames: [string, string][] = [
    ['teradata.json', 'organisation.json'],
    ['ai.json', 'industry.json'],
  ];
  for (const [oldName, newName] of renames) {
    const oldPath = path.join(userDir, oldName);
    const newPath = path.join(userDir, newName);
    if (!fs.existsSync(oldPath)) continue;
    if (fs.existsSync(newPath)) {
      try {
        fs.unlinkSync(oldPath);
        deletedDuplicates.push(oldName);
        logger?.warn(
          { oldName, newName, userDir },
          'vocabulary migration: both old and new scope files existed; deleted old, kept new',
        );
      } catch {
        // best-effort
      }
      continue;
    }
    try {
      fs.renameSync(oldPath, newPath);
      renamed.push(`${oldName} -> ${newName}`);
    } catch {
      // best-effort
    }
  }
  return { renamed, deletedDuplicates };
}

/**
 * Copy bundled vocabulary seed files into the user's editable directory,
 * never overwriting files that already exist there.
 */
export function migrateVocabularyToUserDir(
  bundledDir: string,
  userDir: string,
  _logger?: Logger,
): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(bundledDir)) {
    return { copied, skipped };
  }
  try {
    fs.mkdirSync(userDir, { recursive: true });
  } catch {
    return { copied, skipped };
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(bundledDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return { copied, skipped };
  }
  for (const filename of entries) {
    const src = path.join(bundledDir, filename);
    const dst = path.join(userDir, filename);
    if (fs.existsSync(dst)) {
      skipped.push(filename);
      continue;
    }
    try {
      fs.copyFileSync(src, dst);
      copied.push(filename);
    } catch {
      // best-effort
    }
  }
  return { copied, skipped };
}

export function countVocabularyTerms(file: VocabularyFile): number {
  return (file.whisperHints?.length ?? 0) + (file.replacements?.length ?? 0);
}

const REGEX_METACHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(REGEX_METACHARS, '\\$&');
}

/**
 * Apply replacement rules to a transcript. Word-boundary aware (a rule
 * "AI" won't fire inside "maintain"), case-insensitive, context-gated
 * when the rule asks for it. Returns the corrected text and how many
 * rules actually fired.
 */
export function applyReplacements(
  transcript: string,
  rules: VocabularyReplacement[],
): { text: string; applied: number } {
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
    const leadGroup = startsWithWord ? '(^|\\W)' : '';
    const trailGroup = endsWithWord ? '(\\W|$)' : '';
    const pattern = `${leadGroup}${escaped}${trailGroup}`;
    const re = new RegExp(pattern, 'gi');
    const hasLead = startsWithWord;
    const hasTrail = endsWithWord;
    const before = text;
    text = text.replace(re, (...args: any[]) => {
      const lead = hasLead ? (args[1] ?? '') : '';
      const trail = hasTrail ? (args[hasLead ? 2 : 1] ?? '') : '';
      return `${lead}${rule.to}${trail}`;
    });
    if (text !== before) applied++;
  }
  return { text, applied };
}

/**
 * Parse "Heard as | Should be | Context cue" markdown tables (the format
 * of private/MY-VOCAB.md) into replacement rules. Tables with other
 * headers are ignored.
 */
export function parseVocabularyMarkdownTables(md: string): VocabularyReplacement[] {
  const out: VocabularyReplacement[] = [];
  const lines = md.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const next = lines[i + 1] ?? '';
    if (looksLikeTableRow(line) && looksLikeSeparator(next)) {
      const headerCells = splitTableRow(line);
      const headerMap = recogniseHeader(headerCells);
      if (headerMap === null) {
        i += 2;
        while (i < lines.length && looksLikeTableRow(lines[i] ?? '')) i++;
        continue;
      }
      i += 2;
      while (i < lines.length && looksLikeTableRow(lines[i] ?? '')) {
        const cells = splitTableRow(lines[i] ?? '');
        const entry = rowToReplacement(cells, headerMap);
        if (entry) out.push(entry);
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

function looksLikeTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return trimmed.includes('|');
}

function looksLikeSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.includes('-')) return false;
  for (const ch of trimmed) {
    if (ch !== '-' && ch !== '|' && ch !== ':' && ch !== ' ') return false;
  }
  return true;
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((cell) => cell.trim());
}

interface HeaderMap {
  heardAs: number;
  shouldBe: number;
  context: number | null;
}

function recogniseHeader(cells: string[]): HeaderMap | null {
  let heardAs = -1;
  let shouldBe = -1;
  let context: number | null = null;
  for (let i = 0; i < cells.length; i++) {
    const normalised = cells[i].toLowerCase().trim();
    if (heardAs === -1 && normalised === 'heard as') heardAs = i;
    else if (shouldBe === -1 && normalised === 'should be') shouldBe = i;
    else if (
      context === null &&
      (normalised === 'context cue' || normalised === 'context' || normalised === 'context cues')
    ) {
      context = i;
    }
  }
  if (heardAs === -1 || shouldBe === -1) return null;
  return { heardAs, shouldBe, context };
}

function rowToReplacement(cells: string[], header: HeaderMap): VocabularyReplacement | null {
  const from = (cells[header.heardAs] ?? '').trim();
  const to = (cells[header.shouldBe] ?? '').trim();
  if (from.length === 0 || to.length === 0) return null;
  let requiresContext: string[] | undefined;
  if (header.context !== null) {
    const raw = (cells[header.context] ?? '').trim();
    if (raw.length > 0) {
      const parts = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length > 0) requiresContext = parts;
    }
  }
  return {
    from,
    to,
    ...(requiresContext ? { requiresContext } : {}),
  };
}
