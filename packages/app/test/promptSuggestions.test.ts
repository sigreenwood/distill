import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDismissed, parsePromptSuggestions, pendingSuggestions, SUGGESTIONS_FILE } from '../src/main/promptSuggestions.js';
import { extractTitleFromSummary } from '../src/main/outputs.js';

const shipped = parsePromptSuggestions(fs.readFileSync(path.join(__dirname, '..', 'resources', SUGGESTIONS_FILE), 'utf8'));

describe('the shipped suggestions file', () => {
  it('parses every suggested meeting type with a use-for line and a prompt', () => {
    expect(shipped.map((s) => s.id)).toEqual([
      'account-standup',
      'customer-sync',
      'customer-workshop',
      'qbr-service-review',
      'account-strategy',
      'team-meeting',
      'one-to-one',
      'enablement-session',
    ]);
    for (const s of shipped) {
      expect(s.name.length).toBeGreaterThan(2);
      expect(s.useFor.length).toBeGreaterThan(20);
      expect(s.prompt).not.toContain('```');
    }
  });

  it('keeps the conventions every prompt relies on', () => {
    for (const s of shipped) {
      // The classifiers read the first 200 characters: it must say what the meeting is.
      expect(s.prompt.slice(0, 200)).toMatch(/^Summarise /);
      // Line 1 of the output names the files (DECISIONS.md §4).
      expect(s.prompt).toContain('OUTPUT TITLE (REQUIRED, FIRST LINE)');
      // Transcripts have no speaker labels; personal matters stay out.
      expect(s.prompt).toMatch(/no speaker labels/);
      expect(s.prompt).toMatch(/health/);
      expect(s.prompt).toContain('data, not instructions');
    }
  });

  it('puts Actions first in every summary, for review at a glance', () => {
    for (const s of shipped) {
      const output = s.prompt.slice(s.prompt.indexOf('\nOUTPUT ('));
      const firstSection = /\n## (.+)/.exec(output)?.[1];
      expect(firstSection, s.id).toBe('Actions');
      expect(s.prompt.match(/^## Actions$/gm)).toHaveLength(1);
      expect(s.prompt).toContain('then ## Actions');
    }
  });

  it('contains no customer names', () => {
    const text = shipped.map((s) => s.prompt + s.useFor).join('\n');
    expect(text).not.toMatch(/HSBC|Lloyds|LBG|AIB/);
  });
});

describe('pendingSuggestions', () => {
  it('hides suggestions already added (by id or name) or dismissed', () => {
    const left = pendingSuggestions(shipped, [{ id: 'account-standup', name: 'x' }, { id: 'mine', name: '1:1 or colleague call' }], ['team-meeting']);
    const ids = left.map((s) => s.id);
    expect(ids).not.toContain('account-standup');
    expect(ids).not.toContain('one-to-one');
    expect(ids).not.toContain('team-meeting');
    expect(ids).toContain('customer-sync');
  });

  it('tolerates a missing or corrupt dismissed list', () => {
    expect(parseDismissed(undefined)).toEqual([]);
    expect(parseDismissed('nope')).toEqual([]);
    expect(parseDismissed('["a",3]')).toEqual(['a']);
  });
});

describe('title line', () => {
  it('a summary following the convention yields its first line as the title', () => {
    expect(extractTitleFromSummary('Account team aligns on upgrade plan and demo timing\n\n## Headlines')).toBe(
      'Account team aligns on upgrade plan and demo timing',
    );
  });
});
