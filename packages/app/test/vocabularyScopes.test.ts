import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadVocabulary, applyReplacements } from '../src/main/vocabulary.js';

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

describe('attendee hints and unsaved drafts', () => {
  it('puts attendee names ahead of every scope so overflow drops them last', () => {
    scope('global', Array.from({ length: 150 }, (_, i) => `GlobalTerm${i}`));
    const { whisperPrompt, hintsDropped } = loadVocabulary(dir, null, undefined, ['Aoife Ní Bhriain']);
    expect(whisperPrompt).toContain('Aoife Ní Bhriain');
    expect(hintsDropped.length).toBeGreaterThan(0);
  });

  it('uses a draft in place of the saved hints for its scope', () => {
    scope('global', ['SavedTerm']);
    const { whisperPrompt } = loadVocabulary(dir, null, { scopeId: 'global', hints: ['DraftTerm'] });
    expect(whisperPrompt).toContain('DraftTerm');
    expect(whisperPrompt).not.toContain('SavedTerm');
  });

  it('previews a draft for a client scope that has no file yet', () => {
    const { whisperPrompt } = loadVocabulary(dir, null, { scopeId: 'newclient', hints: ['Fresh'] });
    expect(whisperPrompt).toContain('Fresh');
  });

  it('ignores blank hints rather than counting them against the budget', () => {
    const { hintsAvailable } = loadVocabulary(dir, null, { scopeId: 'global', hints: ['A', '  ', ''] });
    expect(hintsAvailable).toBe(1);
  });
});
