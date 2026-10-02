/**
 * Meeting types offered in Settings → Prompts as suggestions, read from
 * resources/prompts/suggested-meeting-types.md. Accepting one adds it as
 * an ordinary user meeting type; dismissing hides it. Nothing is added
 * without the user's say-so (CLAUDE.md: suggestion-only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parsePromptsMarkdownDetailed } from './seed.js';
import type { PromptSuggestion } from '../shared/promptSuggestion.js';

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

export function parseDismissed(json: string | undefined): string[] {
  try {
    const v = JSON.parse(json ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
