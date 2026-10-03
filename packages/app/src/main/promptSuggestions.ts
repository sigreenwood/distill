/**
 * Meeting types offered in Settings → Prompts as suggestions, read from
 * resources/prompts/suggested-meeting-types.md. Accepting one adds it as
 * an ordinary user meeting type; dismissing hides it. Nothing is added
 * without the user's say-so (CLAUDE.md: suggestion-only).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parsePromptsMarkdownDetailed } from './seed.js';
import type { PromptSuggestion, SuggestionView } from '../shared/promptSuggestion.js';

export const SUGGESTIONS_FILE = path.join('prompts', 'suggested-meeting-types.md');
export const DISMISSED_KEY = 'dismissedPromptSuggestions';

/** Entries with their "Use for:" line, which sits between the heading and the fenced prompt. */
export function parsePromptSuggestions(md: string): PromptSuggestion[] {
  return parsePromptsMarkdownDetailed(md).map((entry) => {
    const heading = md.indexOf(`\`${entry.id}\``);
    const fence = md.indexOf('```', heading);
    const useFor = /Use for:\s*(.+)/.exec(md.slice(heading, fence))?.[1]?.trim() ?? '';
    return { id: entry.id, name: entry.name, useFor, prompt: entry.prompt.trim() };
  });
}

export function readPromptSuggestions(resourcesDir: string): PromptSuggestion[] {
  const file = path.join(resourcesDir, SUGGESTIONS_FILE);
  if (!fs.existsSync(file)) return [];
  return parsePromptSuggestions(fs.readFileSync(file, 'utf8'));
}

/** Suggestions still worth showing: not dismissed, and not already a meeting type by id or name. */
export function pendingSuggestions(
  all: PromptSuggestion[],
  existing: { id: string; name: string }[],
  dismissed: string[],
): PromptSuggestion[] {
  const ids = new Set(existing.map((m) => m.id));
  const names = new Set(existing.map((m) => m.name.trim().toLowerCase()));
  const hidden = new Set(dismissed);
  return all.filter((s) => !ids.has(s.id) && !names.has(s.name.toLowerCase()) && !hidden.has(s.id));
}

export function suggestionVersion(s: PromptSuggestion): string {
  return crypto.createHash('sha1').update(`${s.name}\n${s.useFor}\n${s.prompt}`).digest('hex').slice(0, 10);
}

/**
 * New suggestions (as pendingSuggestions) plus updates: a shipped
 * suggestion whose id is already a meeting type, but whose name,
 * description or prompt differs from it. Applying an update replaces
 * the user's version, so it is only ever offered, never applied.
 */
export function suggestionViews(
  all: PromptSuggestion[],
  existing: { id: string; name: string; prompt: string; description: string | null }[],
  dismissed: string[],
): SuggestionView[] {
  const hidden = new Set(dismissed);
  const fresh: SuggestionView[] = pendingSuggestions(all, existing, dismissed).map((s) => ({ ...s, kind: 'new', key: s.id }));
  const updates: SuggestionView[] = [];
  for (const s of all) {
    const current = existing.find((m) => m.id === s.id);
    if (!current) continue;
    const differs = current.name !== s.name || current.prompt.trim() !== s.prompt.trim() || (current.description ?? '') !== s.useFor;
    const key = `${s.id}@${suggestionVersion(s)}`;
    if (differs && !hidden.has(key)) updates.push({ ...s, kind: 'update', key, currentName: current.name });
  }
  return [...fresh, ...updates];
}

export function parseDismissed(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
