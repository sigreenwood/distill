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
      'team-standup',
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
      // Learned from the trial: judgements of people leaked into a summary
      // under the wrong prompt, empty sections printed "None", and a
      // lunch-chat recording produced a page of nothing.
      expect(s.prompt).toContain('never as judgements of character');
      expect(s.prompt).toContain('No meeting content recorded');
      expect(s.prompt).toContain('except Actions');
      // The same action went to two different people across runs: "I" in a
      // two-person call without speaker labels is not attributable.
      expect(s.prompt).toContain('Owner unclear');
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

  it('keeps the two stand-up types apart for the classifier', () => {
    const single = shipped.find((s) => s.id === 'account-standup')!;
    const multi = shipped.find((s) => s.id === 'team-standup')!;
    expect(single.prompt.slice(0, 200)).toContain('one customer account');
    expect(multi.prompt.slice(0, 200)).toContain('several customer accounts');
    // A round-robin stand-up must not blur one account's updates into another's.
    expect(multi.prompt).toContain('Never move a point from one account to another');
    expect(multi.prompt).toContain('### Account unclear');
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
