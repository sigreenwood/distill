import { describe, it, expect } from 'vitest';
import {
  parsePromptsMarkdown,
  parsePromptsMarkdownDetailed,
  SEED_MEETING_TYPES,
  hashPrompt,
  readSeedPrompt,
} from '../src/main/seed.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Tests for the PROMPTS.md parser and prompt-hash helpers. PROMPTS.md
 * is no longer used to seed meeting types on fresh installs (a
 * contributor's existing dev DB still has the old seeds; new users
 * start with an empty Prompts list). But the file is still parseable
 * and still the source of truth for the "Revert to default" button on
 * an existing built-in, so the parser still needs coverage.
 *
 * Tests that previously iterated `SEED_MEETING_TYPES` to check every
 * seeded prompt are now trivial no-ops (the array is empty). Replaced
 * with hard-coded known-good IDs from the current PROMPTS.md so the
 * parser's actual behaviour stays under test.
 */
describe('parsePromptsMarkdown', () => {
  const promptsPath = resolve(__dirname, '..', '..', '..', 'docs', 'app', 'PROMPTS.md');
  const md = readFileSync(promptsPath, 'utf-8');
  const prompts = parsePromptsMarkdown(md);

  // The four IDs that historically lived in PROMPTS.md. Used as fixtures
  // for the parser tests below; not implying they're seeded any more.
  const KNOWN_IDS = ['client-call', 'training', 'all-hands', 'ladffa'] as const;

  it('extracts every prompt the file declares', () => {
    for (const id of KNOWN_IDS) {
      expect(prompts.has(id), `missing prompt for ${id}`).toBe(true);
      expect(prompts.get(id)!.length).toBeGreaterThan(100);
    }
  });

  it('parses the committee-meeting prompt and preserves its agenda structure', () => {
    const ladffa = prompts.get('ladffa');
    expect(ladffa).toBeDefined();
    // Structural anchors that should survive any future content rewrite:
    // the prompt is a meeting-minutes template with an agenda and an
    // "Action Summary" table.
    expect(ladffa!).toContain('Apologies for Absence');
    expect(ladffa!).toContain('Action Summary');
  });

  it('parses the client-call prompt with its sentiment score section', () => {
    const call = prompts.get('client-call');
    expect(call).toBeDefined();
    expect(call!).toContain('Sentiment Score');
    // The client-call prompt covers business calls and should reference
    // the structured Summary Structure heading the prompt declares.
    expect(call!).toContain('Summary Structure');
  });

  it('does not bleed content between sections', () => {
    const training = prompts.get('training');
    expect(training).toBeDefined();
    // Training prompt should not contain content from the all-hands prompt
    expect(training!).not.toContain('LinkedIn Topic Suggestions');
  });
});

describe('hashPrompt', () => {
  it('produces the same hash for identical input', () => {
    const a = hashPrompt('Hello, world.');
    const b = hashPrompt('Hello, world.');
    expect(a).toBe(b);
  });

  it('produces different hashes for different input', () => {
    const a = hashPrompt('Hello, world.');
    const b = hashPrompt('Hello, world!');
    expect(a).not.toBe(b);
  });

  it('is hex-encoded SHA-256 (64 chars)', () => {
    const hash = hashPrompt('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes whitespace changes', () => {
    // Used by the Prompts pane to detect even trivial edits. A trailing
    // newline change should flip is_modified — that matches user
    // expectation that "anything I typed counts as an edit".
    expect(hashPrompt('x')).not.toBe(hashPrompt('x\n'));
    expect(hashPrompt('x ')).not.toBe(hashPrompt('x'));
  });
});

describe('readSeedPrompt', () => {
  // Walk up from test/ to the repo root so the dev-mode PROMPTS.md
  // path resolves the same way seed.ts does at runtime. (At runtime,
  // `resourcesDir` is the app package's resources dir; readSeedPrompt
  // walks up three levels from there to docs/app/PROMPTS.md.)
  const resourcesDir = resolve(__dirname, '..', 'resources');

  it('returns the seeded prompt for a known id', () => {
    // Test with a known-good id from PROMPTS.md. We're testing the
    // lookup helper, not the seed table; the helper still needs to
    // work for the "Revert to default" button on existing built-ins.
    const prompt = readSeedPrompt(resourcesDir, 'client-call');
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeGreaterThan(100);
  });

  it('returns undefined for an unknown id', () => {
    expect(readSeedPrompt(resourcesDir, 'not-a-real-id')).toBeUndefined();
  });

  it('roundtrips with hashPrompt', () => {
    // If hashPrompt(readSeedPrompt(id)) produces a clean SHA-256, the
    // two helpers agree on the canonical form. Used downstream to
    // detect prompt edits via the is_modified flag.
    const prompt = readSeedPrompt(resourcesDir, 'client-call');
    expect(prompt).toBeDefined();
    const h = hashPrompt(prompt!);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('SEED_MEETING_TYPES', () => {
  it('is an empty list (meeting types are no longer seeded on fresh installs)', () => {
    // Pinned as a regression guard: if anyone re-introduces seeded
    // meeting types, this test should fail loudly so the discussion
    // happens deliberately.
    expect(SEED_MEETING_TYPES).toEqual([]);
  });
});

/**
 * Tests for the richer parser used by the import-prompts IPC handler.
 * Covers the cases that distinguish it from `parsePromptsMarkdown`:
 * display-name extraction from the heading, and humanised fallback
 * when no display name is present.
 *
 * The parser is shape-flexible because users can hand-author the
 * markdown they import — we accept Unicode em-dash, en-dash, and
 * ASCII hyphen as the id-name separator.
 */
describe('parsePromptsMarkdownDetailed', () => {
  it('extracts id, display name, and prompt body from an em-dash heading', () => {
    const md = [
      '## 1. `client-call` — Client Call',
      '',
      '```',
      'You are a meeting summariser for client calls.',
      'Use British English.',
      '```',
      '',
    ].join('\n');

    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('client-call');
    expect(entries[0]!.name).toBe('Client Call');
    expect(entries[0]!.prompt).toContain('You are a meeting summariser');
  });

  it('accepts an en-dash as the heading separator', () => {
    const md =
      '## 1. `quarterly-review` – Quarterly Review\n\n```\nSummarise the quarter.\n```\n';
    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('Quarterly Review');
  });

  it('accepts an ASCII hyphen as the heading separator', () => {
    const md =
      '## 1. `weekly-sync` - Weekly Sync\n\n```\nSummarise the week.\n```\n';
    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('Weekly Sync');
  });

  it('humanises the id as the display name when no name is on the heading', () => {
    const md = '## 1. `all-hands`\n\n```\nSummarise the all-hands.\n```\n';
    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('all-hands');
    // 'all-hands' -> 'All Hands' (each hyphen-separated word title-cased)
    expect(entries[0]!.name).toBe('All Hands');
  });

  it('parses multiple sections without bleeding bodies', () => {
    const md = [
      '## 1. `first` — First',
      '',
      '```',
      'first body',
      '```',
      '',
      '## 2. `second` — Second',
      '',
      '```',
      'second body',
      '```',
      '',
    ].join('\n');

    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).toBe('first');
    expect(entries[0]!.prompt).toBe('first body');
    expect(entries[1]!.id).toBe('second');
    expect(entries[1]!.prompt).toBe('second body');
    // Confirm no cross-contamination.
    expect(entries[0]!.prompt).not.toContain('second');
    expect(entries[1]!.prompt).not.toContain('first body');
  });

  it('skips sections without a fenced code block', () => {
    const md = [
      '## 1. `with-body` — With Body',
      '',
      '```',
      'has a body',
      '```',
      '',
      '## 2. `no-body` — No Body',
      '',
      'Just prose, no fence.',
      '',
    ].join('\n');

    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('with-body');
  });

  it('returns an empty array for markdown with no recognisable headings', () => {
    const md = '# Just a Doc\n\nNo prompt sections here.\n';
    expect(parsePromptsMarkdownDetailed(md)).toEqual([]);
  });

  it('agrees with parsePromptsMarkdown on id-to-prompt mapping', () => {
    // The simple parser is now implemented in terms of the detailed
    // one; lock that contract so a future divergence surfaces.
    const md = [
      '## 1. `a` — A',
      '',
      '```',
      'A body',
      '```',
      '',
      '## 2. `b` — B',
      '',
      '```',
      'B body',
      '```',
      '',
    ].join('\n');

    const detailed = parsePromptsMarkdownDetailed(md);
    const simple = parsePromptsMarkdown(md);
    expect(simple.size).toBe(detailed.length);
    for (const entry of detailed) {
      expect(simple.get(entry.id)).toBe(entry.prompt);
    }
  });

  it('tolerates four-backtick fences (so prompts can contain triple-backtick code samples)', () => {
    const md = [
      '## 1. `with-fences` — With Fences',
      '',
      '````',
      'Use ```sql for queries.',
      '````',
      '',
    ].join('\n');

    const entries = parsePromptsMarkdownDetailed(md);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.prompt).toContain('Use ```sql');
  });
});
