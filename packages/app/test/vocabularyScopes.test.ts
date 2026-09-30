import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadVocabulary, applyReplacements, addReplacementRule } from '../src/main/vocabulary.js';
import type { VocabularyFile } from '../src/main/vocabulary.js';

let dir: string;

function scope(name: string, hints: string[], replacements: unknown[] = []) {
  fs.writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ $version: 1, whisperHints: hints, replacements }),
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-vocab-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('scope precedence in the Whisper prompt', () => {
  it('keeps client terms when the budget overflows', () => {
    // Regression: scopes were merged broadest-first and overflow is
    // dropped from the tail, so a populated global scope could evict
    // every client-specific term — the ones most likely to matter for
    // the meeting being transcribed.
    scope('global', Array.from({ length: 60 }, (_, i) => `GlobalTerm${i}`));
    scope('organisation', Array.from({ length: 60 }, (_, i) => `OrgTerm${i}`));
    scope('industry', Array.from({ length: 40 }, (_, i) => `IndustryTerm${i}`));
    scope('acme', ['Rajesh', 'Prashant', 'Biocatch', 'Celebrus', 'VantageCloud']);

    const { whisperPrompt } = loadVocabulary(dir, 'acme');

    expect(whisperPrompt.length).toBeLessThanOrEqual(800);
    for (const term of ['Rajesh', 'Prashant', 'Biocatch', 'Celebrus', 'VantageCloud']) {
      expect(whisperPrompt).toContain(term);
    }
  });

  it('orders scopes most-specific first', () => {
    scope('global', ['GlobalOnly']);
    scope('organisation', ['OrgOnly']);
    scope('acme', ['ClientOnly']);
    const { whisperPrompt } = loadVocabulary(dir, 'acme');
    expect(whisperPrompt.indexOf('ClientOnly')).toBeLessThan(whisperPrompt.indexOf('OrgOnly'));
    expect(whisperPrompt.indexOf('OrgOnly')).toBeLessThan(whisperPrompt.indexOf('GlobalOnly'));
  });

  it('spends the budget once on a term that differs only in case', () => {
    // Real transcripts contain both "PEGA" and "Pega"; to Whisper they
    // are the same hint but two charges against 800 characters.
    scope('global', ['PEGA', 'pega']);
    scope('acme', ['Pega']);
    const { whisperPrompt } = loadVocabulary(dir, 'acme');
    const occurrences = whisperPrompt.toLowerCase().split('pega').length - 1;
    expect(occurrences).toBe(1);
    // The most specific scope's spelling is the one kept.
    expect(whisperPrompt).toContain('Pega');
  });

  it('still works with no client scope', () => {
    scope('global', ['GlobalOnly']);
    const { whisperPrompt, sources } = loadVocabulary(dir, null);
    expect(whisperPrompt).toContain('GlobalOnly');
    expect(sources).toEqual(['global.json']);
  });

  it('reports only the scopes that exist', () => {
    scope('organisation', ['A']);
    scope('acme', ['B']);
    expect(loadVocabulary(dir, 'acme').sources).toEqual(['acme.json', 'organisation.json']);
  });
});

describe('conflicting replacement rules', () => {
  it('reports rules that rewrite the same term differently', () => {
    // Matching is case-insensitive, so rules chain rather than compete:
    // sim -> SIM followed by sim -> CIM yields CIM, because the second
    // rule re-matches what the first just wrote. Whichever file loads
    // last quietly wins, which is invisible when curating separate
    // scope files — so it is reported rather than silently resolved.
    scope('acme', [], [{ from: 'sim', to: 'SIM' }]);
    scope('global', [], [{ from: 'Sim', to: 'CIM' }]);

    const v = loadVocabulary(dir, 'acme');
    expect(v.conflictingRules).toHaveLength(1);
    expect(v.conflictingRules[0]).toMatchObject({ winner: 'CIM', overridden: ['SIM'] });

    // And the reported winner is what actually happens.
    const { text } = applyReplacements('we discussed the sim today', v.replacements);
    expect(text).toContain('CIM');
  });

  it('does not flag identical rules duplicated across scopes', () => {
    scope('acme', [], [{ from: 'acmee', to: 'Acme' }]);
    scope('global', [], [{ from: 'acmee', to: 'Acme' }]);
    expect(loadVocabulary(dir, 'acme').conflictingRules).toEqual([]);
  });
});

describe('unsaved edits (budget preview)', () => {
  it('counts draft hints instead of what is on disk', () => {
    scope('global', ['Saved']);
    scope('organisation', ['OrgTerm']);
    const v = loadVocabulary(dir, null, { scopeId: 'global', hints: ['Draft', 'Second'] });
    expect(v.whisperPrompt).toContain('Draft');
    expect(v.whisperPrompt).toContain('Second');
    expect(v.whisperPrompt).not.toContain('Saved');
    // Other scopes are unaffected — the merged total is what is budgeted.
    expect(v.whisperPrompt).toContain('OrgTerm');
    expect(v.hintsAvailable).toBe(3);
  });

  it('counts a draft for a scope with no file yet', () => {
    scope('global', ['GlobalOnly']);
    const v = loadVocabulary(dir, 'newclient', { scopeId: 'newclient', hints: ['BrandNew'] });
    expect(v.whisperPrompt).toContain('BrandNew');
    expect(v.hintsAvailable).toBe(2);
  });

  it('ignores blank rows left by the editor', () => {
    // "+ Add hint" inserts an empty row; it must not widen the prompt, and
    // must not count as a term — every string contains the empty string, so
    // a blank would otherwise never register as dropped.
    scope('global', []);
    const v = loadVocabulary(dir, null, { scopeId: 'global', hints: ['Real', '', '   '] });
    expect(v.hintsAvailable).toBe(1);
    expect(v.hintsDropped).toEqual([]);
    expect(v.whisperPrompt).not.toContain(', ,');
  });

  it('reports draft terms that overflow the limit', () => {
    const many = Array.from({ length: 120 }, (_, i) => `VeryLongDraftTerm${i}`);
    scope('global', []);
    const v = loadVocabulary(dir, null, { scopeId: 'global', hints: many });
    expect(v.whisperPrompt.length).toBeLessThanOrEqual(800);
    expect(v.hintsDropped.length).toBeGreaterThan(0);
    expect(v.hintsUsed + v.hintsDropped.length).toBe(v.hintsAvailable);
  });
});

describe('vocabulary budget reporting', () => {
  it('reports which terms did not fit', () => {
    scope('global', Array.from({ length: 200 }, (_, i) => `VeryLongGlobalTerm${i}`));
    const v = loadVocabulary(dir, null);
    expect(v.hintsUsed).toBeLessThan(v.hintsAvailable);
    expect(v.hintsDropped.length).toBe(v.hintsAvailable - v.hintsUsed);
  });

  it('reports nothing dropped when everything fits', () => {
    scope('global', ['Teradata', 'Biocatch']);
    const v = loadVocabulary(dir, null);
    expect(v.hintsDropped).toEqual([]);
    expect(v.hintsUsed).toBe(2);
  });
});

describe('addReplacementRule', () => {
  const empty: VocabularyFile = { $version: 1, whisperHints: [], replacements: [] };

  it('appends a new rule', () => {
    const next = addReplacementRule(empty, { from: 'Prashant', to: 'Samir' });
    expect(next.replacements).toEqual([{ from: 'Prashant', to: 'Samir' }]);
  });

  it('updates an existing rule for the same "from", case-insensitively, instead of duplicating it', () => {
    const withRule: VocabularyFile = { ...empty, replacements: [{ from: 'prashant', to: 'Samir' }] };
    const next = addReplacementRule(withRule, { from: 'Prashant', to: 'Prashanth' });
    expect(next.replacements).toEqual([{ from: 'Prashant', to: 'Prashanth' }]);
  });

  it('leaves other rules and file fields untouched', () => {
    const withRule: VocabularyFile = {
      $version: 1,
      whisperHints: ['Teradata'],
      replacements: [{ from: 'sim', to: 'SIM', requiresContext: ['bank'] }],
    };
    const next = addReplacementRule(withRule, { from: 'Rajesh', to: 'Rajesh Kumar' });
    expect(next.whisperHints).toEqual(['Teradata']);
    expect(next.replacements).toEqual([
      { from: 'sim', to: 'SIM', requiresContext: ['bank'] },
      { from: 'Rajesh', to: 'Rajesh Kumar' },
    ]);
  });
});
