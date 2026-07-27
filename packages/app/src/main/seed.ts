import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { State } from './state.js';

export function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

// No clients are seeded by default — users add their own from the tag
// sheet's "+ Add new client…" affordance. See docs/app/README.md.
const SEED_CLIENTS: { id: string; name: string; sort_order: number }[] = [];

export interface SeedPromptEntry {
  id: string;
  name: string;
  prompt: string;
}

export function parsePromptsMarkdown(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of parsePromptsMarkdownDetailed(md)) {
    out.set(entry.id, entry.prompt);
  }
  return out;
}

export function parsePromptsMarkdownDetailed(md: string): SeedPromptEntry[] {
  const out: SeedPromptEntry[] = [];
  const headingRegex = /^##\s+\d+\.\s+`([a-z0-9-]+)`(.*)$/gm;
  const matches = [...md.matchAll(headingRegex)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index == null) continue;
    const id = m[1];
    if (!id) continue;
    const tail = (m[2] ?? '').trim();
    let name = tail.replace(/^[—–-]\s*/, '').trim();
    if (name.length === 0) {
      name = id
        .split('-')
        .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
        .join(' ');
    }
    const sectionStart = m.index;
    const nextMatch = matches[i + 1];
    const sectionEnd = nextMatch?.index ?? md.length;
    const section = md.slice(sectionStart, sectionEnd);
    const fence = section.match(/^(`{3,})\s*\n([\s\S]*?)\n\1\s*$/m);
    if (fence && fence[2] != null) {
      out.push({ id, name, prompt: fence[2] });
    }
  }
  return out;
}

export function findPromptsMarkdown(resourcesDir: string): string {
  const packaged = path.join(resourcesDir, 'PROMPTS.md');
  const dev = path.resolve(resourcesDir, '..', '..', '..', 'docs', 'app', 'PROMPTS.md');
  try {
    return fs.readFileSync(packaged, 'utf-8');
  } catch (packagedErr: any) {
    try {
      return fs.readFileSync(dev, 'utf-8');
    } catch (devErr: any) {
      throw new Error(
        `Could not find PROMPTS.md — the seed file for built-in meeting type prompts.

This is expected in fresh packaged installs (no built-in prompts to revert).
If you're seeing this from a Revert button, the prompt was probably migrated
from a contributor's database; try editing the prompt text directly instead,
or delete and re-create the prompt as a user-created one.

  Tried packaged: ${packaged}
  Tried dev:      ${dev}
  Packaged read failed: ${packagedErr.message}
  Dev read failed:      ${devErr.message}`,
      );
    }
  }
}

export function seedIfEmpty(
  state: State,
  _resourcesDir: string,
): { seeded: boolean; notes: string[] } {
  const notes: string[] = [];
  let seeded = false;
  if (state.listClients().length === 0) {
    for (const c of SEED_CLIENTS) {
      state.upsertClient({ ...c, is_builtin: 1 });
    }
    notes.push(`Seeded ${SEED_CLIENTS.length} clients`);
    seeded = true;
  }
  return { seeded, notes };
}

export function readSeedPrompt(resourcesDir: string, id: string): string | undefined {
  const md = findPromptsMarkdown(resourcesDir);
  return parsePromptsMarkdown(md).get(id);
}
