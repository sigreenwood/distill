/**
 * Seed default clients on first launch.
 *
 * Idempotent: only inserts if the clients table is empty. Does not
 * overwrite anything on subsequent launches.
 *
 * Both clients and meeting types are NO LONGER seeded on fresh
 * installs. New users land with an empty Prompts list, and an empty
 * client list. They add their own as they go via Settings -> Prompts
 * and the tag sheet's "+ Add new client…" affordance.
 *
 * Earlier shapes seeded a small number of meeting types tuned for a
 * specific user's preferred output shape, plus that user's specific
 * work clients. Both carried opinions that didn't generalise to
 * colleagues.
 *
 * PROMPTS.md is still bundled into the .app and still readable by
 * `readSeedPrompt` so the existing "Revert to default" button on
 * any already-seeded built-ins continues to work. Fresh installs
 * never have any built-ins so the revert button never appears for
 * them.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { State } from './state.js';

export interface SeedClient {
  id: string;
  name: string;
  sort_order: number;
}

export interface SeedMeetingType {
  id: string;
  name: string;
  sort_order: number;
}

/**
 * SHA-256 of a prompt, hex-encoded. Used to record the originally-seeded
 * prompt so the Prompts pane can detect when a built-in has been edited
 * and surface a "revert to default" action. See DECISIONS.md §3.
 *
 * Exported so the IPC layer can reuse the same algorithm when checking
 * modification state on read and when resetting to default.
 */
export function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

/**
 * No clients are seeded on fresh installs. The tag sheet handles an
 * empty client list gracefully — the user picks "+ Add new client…"
 * from the dropdown to create their first client inline. Same
 * pattern as meeting types (which were dropped in commit 930ad68).
 *
 * Earlier shapes seeded contributor-specific work clients, then
 * dropped those down to a single `Unclassified` fallback. Both shapes
 * carried opinions that didn't generalise to colleagues, so we now
 * ship a true empty list. A contributor's existing dev DB keeps
 * whatever's already in it because the seed is idempotent.
 */
export const SEED_CLIENTS: SeedClient[] = [];

/**
 * No meeting types are seeded on fresh installs. Kept as an empty
 * exported array so existing call sites (state assertions, tests)
 * still type-check without conditionals. See the docstring at the
 * top of this file for the full rationale.
 */
export const SEED_MEETING_TYPES: SeedMeetingType[] = [];

/**
 * Parse PROMPTS.md and return a map of { meeting_type_id -> prompt text }.
 *
 * PROMPTS.md uses fenced code blocks (```) around each prompt. Each prompt
 * section is preceded by a heading like `## 1. \`client-call\` — …`. We
 * match on the backticked id in the heading and then capture the first
 * fenced block that follows it.
 *
 * This is deliberately a small custom parser rather than pulling in a full
 * markdown library for the seed path. If PROMPTS.md structure changes,
 * update this and the prompt tests together.
 */
export function parsePromptsMarkdown(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of parsePromptsMarkdownDetailed(md)) {
    out.set(entry.id, entry.prompt);
  }
  return out;
}

/**
 * Single parsed entry from a prompts markdown file. Returned by
 * `parsePromptsMarkdownDetailed` when callers need the display name
 * alongside the id and body — specifically the import-prompts IPC
 * handler, which has to upsert a `meeting_types` row that needs both
 * a stable id (for matching) and a human-readable name (for the
 * sidebar in the Prompts pane).
 *
 * `name` falls back to a humanised version of the id (hyphens to
 * spaces, words title-cased) if the heading didn't include an
 * em-dash-separated display name.
 */
export interface ParsedPromptEntry {
  id: string;
  name: string;
  prompt: string;
}

/**
 * Parse PROMPTS.md (or any markdown file in the same shape) and
 * return one entry per recognised section. Headings are expected to
 * look like:
 *
 *     ## 1. `<id>` — <Display Name>
 *     ## 2. `<id>` - <Display Name>            (ASCII hyphen also OK)
 *     ## 3. `<id>`                              (no name; id is humanised)
 *
 * The id is the backticked slug; the name is whatever follows the
 * em-dash or ASCII-hyphen on the heading line, trimmed. Unicode
 * em-dash (—) and en-dash (–) are both accepted; ASCII `-` works
 * too.
 *
 * The body is the FIRST fenced code block in the section, with the
 * fence stripped. Fences may be three or more backticks so prompts
 * that themselves contain triple-backtick code samples can use
 * four-backtick outer fences.
 *
 * Sections without a parseable fenced block are silently skipped —
 * matches the existing parsePromptsMarkdown behaviour. The caller
 * decides whether to error on "no entries found" (which the import
 * handler does, since an empty parse on a user-supplied file is
 * almost certainly a malformed file rather than an intentional
 * empty import).
 */
export function parsePromptsMarkdownDetailed(md: string): ParsedPromptEntry[] {
  const out: ParsedPromptEntry[] = [];

  // Capture the heading line in full so we can pull both the id
  // and the trailing display name. Group 1 is the id; group 2 is
  // the rest of the heading line (display name + any trailing
  // whitespace), which may be empty.
  const headingRegex = /^##\s+\d+\.\s+`([a-z0-9-]+)`(.*)$/gm;

  const matches = [...md.matchAll(headingRegex)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (!m || m.index == null) continue;

    const id = m[1];
    if (!id) continue;

    // Display name extraction: take what follows the id backtick,
    // strip a leading em-dash / en-dash / ASCII hyphen separator
    // (with surrounding whitespace), and trim. If nothing is left,
    // fall back to a humanised version of the id.
    const tail = (m[2] ?? '').trim();
    let name = tail.replace(/^[\u2014\u2013-]\s*/, '').trim();
    if (name.length === 0) {
      // Humanise: 'all-hands' -> 'All Hands', 'client-call' -> 'Client Call'.
      name = id
        .split('-')
        .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
        .join(' ');
    }

    const sectionStart = m.index;
    const nextMatch = matches[i + 1];
    const sectionEnd = nextMatch?.index ?? md.length;
    const section = md.slice(sectionStart, sectionEnd);

    // First fenced block in the section. Match >=3 backticks; the
    // closing fence must be the same length as the opening fence.
    const fence = section.match(/^(`{3,})\s*\n([\s\S]*?)\n\1\s*$/m);
    if (fence && fence[2] != null) {
      out.push({ id, name, prompt: fence[2] });
    }
  }
  return out;
}

/**
 * Locate PROMPTS.md on disk.
 *
 * PROMPTS.md is no longer bundled into packaged installs (a fresh
 * .pkg install has no built-in prompts, so there's never anything
 * to "revert to default" against). The file is only available in
 * contributor dev environments where it lives at
 * <repoRoot>/docs/app/PROMPTS.md.
 *
 * Two cases:
 *
 *   - Dev (`npm run dev`): walk up from packages/app/resources/ to
 *     find the repo's docs/app/PROMPTS.md.
 *
 *   - Packaged: PROMPTS.md is intentionally absent. The only code
 *     path that calls into here is the revert-to-default IPC
 *     handler, which only fires when a built-in prompt exists.
 *     Fresh installs have no built-ins. If somehow a built-in
 *     does exist on a packaged install (e.g. someone migrated
 *     state.db from a contributor's machine), throw a clear error
 *     so the user knows what's wrong and can either reinstall on
 *     a fresh DB or clone the repo to dev-mode.
 *
 * Read the packaged path first as a defence-in-depth (in case some
 * future build ever does include it); fall back to dev. Throw with
 * both paths if neither works, plus a hint about why this might be
 * happening in a packaged install.
 */
export function findPromptsMarkdown(resourcesDir: string): string {
  // Packaged location — only present if a contributor manually
  // bundles it back in. Default packaged builds don't include it.
  const packaged = join(resourcesDir, 'PROMPTS.md');

  // Dev location — docs/app/PROMPTS.md relative to the repo root.
  // From packages/app/resources/, walking up three levels lands at
  // the repo root.
  const dev = resolve(resourcesDir, '..', '..', '..', 'docs', 'app', 'PROMPTS.md');

  try {
    return readFileSync(packaged, 'utf-8');
  } catch (packagedErr) {
    try {
      return readFileSync(dev, 'utf-8');
    } catch (devErr) {
      // Both reads failed. Surface both paths so the user can see
      // which install shape was assumed.
      throw new Error(
        `Could not find PROMPTS.md — the seed file for built-in meeting type prompts.\n` +
          `\n` +
          `This is expected in fresh packaged installs (no built-in prompts to revert).\n` +
          `If you're seeing this from a Revert button, the prompt was probably migrated\n` +
          `from a contributor's database; try editing the prompt text directly instead,\n` +
          `or delete and re-create the prompt as a user-created one.\n` +
          `\n` +
          `  Tried packaged: ${packaged}\n` +
          `  Tried dev:      ${dev}\n` +
          `  Packaged read failed: ${(packagedErr as Error).message}\n` +
          `  Dev read failed:      ${(devErr as Error).message}`,
      );
    }
  }
}

export function seedIfEmpty(
  state: State,
  // resourcesDir was previously used to locate PROMPTS.md for meeting-type
  // seeding; we no longer seed meeting types so it's unused here. Kept in
  // the signature so call sites in index.ts don't have to change in this
  // commit. Marked with a leading underscore so the unused-parameter rule
  // doesn't trip.
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

  // Meeting types are deliberately not seeded. New users add their own
  // via Settings -> Prompts -> "Add new prompt". See file docstring.

  return { seeded, notes };
}

/**
 * Look up a single seeded prompt's current content from PROMPTS.md.
 * Returns undefined if the id isn't in PROMPTS.md. Used by the
 * "revert to default" IPC handler to restore a built-in prompt
 * without re-seeding everything.
 *
 * Note: this reads PROMPTS.md fresh on every call. That's fine — the
 * file is small and revert is a user-triggered action, not a hot
 * path.
 */
export function readSeedPrompt(
  resourcesDir: string,
  id: string,
): string | undefined {
  const md = findPromptsMarkdown(resourcesDir);
  return parsePromptsMarkdown(md).get(id);
}
