import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './logger.js';

export const WHISPER_PROMPT_CHAR_LIMIT = 800;

/**
 * Style anchor prepended to every transcription.
 *
 * Whisper's initial_prompt is not an instruction — the model *continues*
 * from it, and so imitates its formatting. With no prompt at all, a
 * crosstalk-heavy opening ("hi there / hi john / hi simon" over each
 * other) leaves Whisper with nothing to pattern-match and it settles
 * into lowercase, unpunctuated output for the first stretch of the
 * meeting.
 *
 * Measured on a real call's first 90 seconds, large-v3-turbo:
 *   no prompt      — 0.6% uppercase,  0 sentence marks
 *                    "hi there hi john hi simon hi rs good afternoon"
 *   style anchor   — 9.9% uppercase, 12 sentence marks
 *                    "Hi there. Hi John. Hi Simon. Hi Aris. Good afternoon."
 *   hints + anchor — 12.2% uppercase, 19 sentence marks
 *
 * Note "hi rs" became "Hi Aris": anchoring the style recovered a name
 * outright, so this is an accuracy fix and not only a cosmetic one.
 *
 * Deliberately written AS well-formed meeting speech rather than as an
 * instruction about formatting, because demonstration is what Whisper
 * responds to. Kept short and generic so there is little for the model
 * to echo into the transcript.
 */
const WHISPER_STYLE_ANCHOR =
  "Good morning, everyone. Thanks for joining. Let's start with the agenda, then the technical items.";

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
  /** Distinct hints across all scopes, after case-insensitive dedupe. */
  hintsAvailable: number;
  /** How many actually fitted in Whisper's 800-character prompt. */
  hintsUsed: number;
  /** Hints that did not fit and were therefore not used at all. */
  hintsDropped: string[];
  /**
   * Replacement rules whose `from` collides with an earlier rule's.
   *
   * Matching is case-insensitive, so rules chain rather than compete:
   * `sim -> SIM` followed by `sim -> CIM` produces CIM, because the
   * second rule re-matches what the first just wrote. Whichever file
   * loads last quietly wins, which is not obvious when the rules live
   * in different scopes.
   */
  conflictingRules: { from: string; winner: string; overridden: string[] }[];
}

/**
 * Merge the vocabulary scopes into one flat list.
 *
 * The scopes carry no special meaning — they exist so keywords can be
 * managed in separate files, and every term ends up in the same prompt.
 * Order matters for exactly one reason: Whisper's prompt is capped at
 * 800 characters and overflow is dropped from the tail. Loading the
 * broad scopes first meant per-client terms — the ones most likely to
 * matter for the meeting actually being transcribed — were discarded
 * first. Demonstrated with a plausible setup (60 global + 60
 * organisation + 40 industry + 5 client terms): all five client terms
 * were dropped and the budget went entirely to generic ones. Loading
 * narrowest-first makes the truncation sacrifice the least specific
 * terms instead.
 *
 * Missing files are fine; malformed JSON is an error the pipeline
 * surfaces.
 */
export function loadVocabulary(
  vocabularyDir: string,
  clientId?: string | null,
  draft?: { scopeId: string; hints: string[] },
  extraHints: string[] = [],
): LoadedVocabulary {
  const sources: string[] = [];
  // extraHints (e.g. this recording's pasted attendee names) go first —
  // more specific than even client-scope vocabulary, so they're the last
  // thing dropped if the 800-char budget runs out. Not a vocabulary
  // *file*, so they don't appear in `sources` (which stays about which
  // scope files contributed, for the vocabulary_sources column).
  const hints: string[] = [...extraHints];
  const replacements: VocabularyReplacement[] = [];
  const files: string[] = [];
  if (clientId) files.push(`${clientId}.json`);
  files.push('organisation.json', 'industry.json', 'global.json');
  const draftFile = draft ? `${draft.scopeId}.json` : null;
  // A draft scope counts even when its file does not exist yet, otherwise
  // the budget for a brand-new client scope reads as zero while typing.
  if (draftFile && !files.includes(draftFile)) files.unshift(draftFile);
  for (const filename of files) {
    const p = path.join(vocabularyDir, filename);
    const isDraft = filename === draftFile;
    if (!isDraft && !fs.existsSync(p)) continue;
    try {
      const data = fs.existsSync(p)
        ? (JSON.parse(fs.readFileSync(p, 'utf-8')) as Partial<VocabularyFile>)
        : {};
      // The draft is what the editor currently shows, saved or not.
      const scopeHints = isDraft ? draft!.hints : data.whisperHints;
      if (scopeHints) hints.push(...scopeHints);
      if (data.replacements) replacements.push(...data.replacements);
      sources.push(filename);
    } catch (e) {
      throw new Error(`Invalid vocabulary file ${p}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Deduplicate case-insensitively, keeping the first — i.e. the most
  // specific scope's spelling. "PEGA" and "Pega" are the same term to
  // Whisper but two charges against an 800-character budget, and real
  // transcripts contain both.
  const seen = new Set<string>();
  const uniqueHints: string[] = [];
  for (const raw of hints) {
    // Blank rows exist while editing ("+ Add hint" starts empty) and would
    // otherwise widen the prompt with ", , " and break the dropped-term
    // check, since every string contains the empty string.
    const h = raw.trim();
    if (h.length === 0) continue;
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueHints.push(h);
  }
  const whisperPrompt = buildWhisperPrompt(uniqueHints);
  // The 800-character cap is Whisper's, not ours, and it is enforced
  // silently. Someone curating keywords across several files has no way
  // to know they have passed the point where new terms stop having any
  // effect, so report it rather than leaving it to be discovered.
  const hintsDropped = uniqueHints.filter((h) => !whisperPrompt.includes(h));

  // Rules sharing a `from` chain instead of competing, so the last one
  // loaded silently decides the result. Report rather than resolve:
  // picking a winner would be hidden logic, and the fix belongs in
  // whichever file the author didn't mean to write.
  const byFrom = new Map<string, VocabularyReplacement[]>();
  for (const r of replacements) {
    const key = r.from.toLowerCase();
    byFrom.set(key, [...(byFrom.get(key) ?? []), r]);
  }
  const conflictingRules = [...byFrom.values()]
    .filter((rules) => rules.length > 1 && new Set(rules.map((r) => r.to)).size > 1)
    .map((rules) => ({
      from: rules[0].from,
      winner: rules[rules.length - 1].to,
      overridden: rules.slice(0, -1).map((r) => r.to),
    }));

  return {
    whisperPrompt,
    replacements,
    sources,
    hintsAvailable: uniqueHints.length,
    hintsUsed: uniqueHints.length - hintsDropped.length,
    hintsDropped,
    conflictingRules,
  };
}

/**
 * Whisper initial_prompt: a comma-separated hint list capped at 800 chars
 * (whisper truncates around 224 tokens; over-long prompts also degrade
 * accuracy). Hints are dropped from the tail when over budget.
 */
export function buildWhisperPrompt(hints: string[]): string {
  // Always return a prompt. Even with no vocabulary configured the style
  // anchor earns its place — see WHISPER_STYLE_ANCHOR for the numbers.
  const trailer = ` ${WHISPER_STYLE_ANCHOR}`;
  if (hints.length === 0) return WHISPER_STYLE_ANCHOR;

  const hintList = hints.join(', ');
  const full = `${hintList}.${trailer}`;
  if (full.length <= WHISPER_PROMPT_CHAR_LIMIT) return full;

  // Over budget: drop hints from the tail, never the anchor, since the
  // anchor is what keeps the transcript readable.
  const budget = WHISPER_PROMPT_CHAR_LIMIT - trailer.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const h of hints) {
    const cost = h.length + 2;
    if (used + cost > budget) break;
    kept.push(h);
    used += cost;
  }
  if (kept.length === 0) return WHISPER_STYLE_ANCHOR;
  return `${kept.join(', ')}.${trailer}`;
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
 * Add or update one replacement rule in a vocabulary file, keyed
 * case-insensitively on `from` — a repeated correction updates its
 * existing rule's `to` rather than accumulating duplicates. Used to turn
 * a one-off transcript correction (see meetingContent.ts) into a
 * reusable rule at whatever scope the user picked.
 */
export function addReplacementRule(file: VocabularyFile, rule: VocabularyReplacement): VocabularyFile {
  const fromLower = rule.from.toLowerCase();
  const replacements = file.replacements ?? [];
  const index = replacements.findIndex((r) => r.from.toLowerCase() === fromLower);
  const next = [...replacements];
  if (index >= 0) next[index] = rule;
  else next.push(rule);
  return { ...file, replacements: next };
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
