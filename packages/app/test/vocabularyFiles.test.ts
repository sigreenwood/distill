/**
 * Tests for the single-scope vocabulary file I/O helpers.
 *
 * These are pure-fs pure-JSON functions — tests write to a tmp
 * directory and assert on the resulting files. No DB, no Electron.
 *
 * See DECISIONS.md §2 for the JSON-files-on-disk design.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_SCOPE_IDS,
  countVocabularyTerms,
  isBuiltinScopeId,
  readVocabularyFile,
  writeVocabularyFile,
  type VocabularyFile,
} from '../src/main/vocabulary.js';

let vocabDir: string;

beforeEach(() => {
  vocabDir = mkdtempSync(join(tmpdir(), 'plaud-vocab-test-'));
});

describe('readVocabularyFile', () => {
  it('returns an empty-shape file for a scope whose JSON does not exist', () => {
    const result = readVocabularyFile(vocabDir, 'nonexistent-scope');
    expect(result).toEqual({
      $version: 1,
      whisperHints: [],
      replacements: [],
    });
    // Reading should not have created the file.
    expect(existsSync(join(vocabDir, 'nonexistent-scope.json'))).toBe(false);
  });

  it('reads a written file back round-trip', () => {
    const original: VocabularyFile = {
      $description: 'Test scope',
      $version: 1,
      whisperHints: ['Acme Corp', 'Globex'],
      replacements: [
        { from: 'akmee', to: 'Acme' },
        {
          from: 'sim',
          to: 'CIM',
          requiresContext: ['marketing', 'campaign'],
        },
      ],
      notes: ['Added April 2026'],
    };
    writeVocabularyFile(vocabDir, 'client-test', original);
    const loaded = readVocabularyFile(vocabDir, 'client-test');
    expect(loaded).toEqual(original);
  });

  it('throws on malformed JSON', () => {
    const path = join(vocabDir, 'broken.json');
    // Write invalid JSON directly via fs (not via writeVocabularyFile,
    // which always produces valid JSON).
    writeFileSync(path, '{ this is not JSON', 'utf-8');
    expect(() => readVocabularyFile(vocabDir, 'broken')).toThrow(
      /Invalid vocabulary file/,
    );
  });
});

describe('writeVocabularyFile', () => {
  it('creates the vocabulary directory if it does not exist', () => {
    rmSync(vocabDir, { recursive: true, force: true });
    expect(existsSync(vocabDir)).toBe(false);

    writeVocabularyFile(vocabDir, 'fresh', {
      $version: 1,
      whisperHints: ['foo'],
      replacements: [],
    });

    expect(existsSync(join(vocabDir, 'fresh.json'))).toBe(true);
  });

  it('produces 2-space-indented JSON with a trailing newline', () => {
    writeVocabularyFile(vocabDir, 'formatted', {
      $version: 1,
      whisperHints: ['one'],
      replacements: [],
    });
    const raw = readFileSync(join(vocabDir, 'formatted.json'), 'utf-8');
    // Trailing newline matches the hand-authored convention so
    // app-saved and human-saved files stay visually consistent.
    expect(raw.endsWith('\n')).toBe(true);
    // 2-space indent on nested keys.
    expect(raw).toContain('\n  "whisperHints":');
  });

  it('overwrites existing content', () => {
    writeVocabularyFile(vocabDir, 'twice', {
      whisperHints: ['first'],
      replacements: [],
    });
    writeVocabularyFile(vocabDir, 'twice', {
      whisperHints: ['second'],
      replacements: [],
    });
    const loaded = readVocabularyFile(vocabDir, 'twice');
    expect(loaded.whisperHints).toEqual(['second']);
  });
});

describe('countVocabularyTerms', () => {
  it('counts hints plus replacements, ignoring metadata', () => {
    const file: VocabularyFile = {
      $description: 'ignored',
      $version: 1,
      whisperHints: ['a', 'b', 'c'],
      replacements: [
        { from: 'x', to: 'X' },
        { from: 'y', to: 'Y' },
      ],
      notes: ['ignored'],
    };
    expect(countVocabularyTerms(file)).toBe(5);
  });

  it('handles missing optional arrays', () => {
    expect(countVocabularyTerms({})).toBe(0);
    expect(countVocabularyTerms({ whisperHints: ['only'] })).toBe(1);
    expect(
      countVocabularyTerms({
        replacements: [{ from: 'x', to: 'X' }],
      }),
    ).toBe(1);
  });
});

describe('isBuiltinScopeId', () => {
  it('returns true for the three built-in pack ids', () => {
    expect(isBuiltinScopeId('global')).toBe(true);
    expect(isBuiltinScopeId('organisation')).toBe(true);
    expect(isBuiltinScopeId('industry')).toBe(true);
  });

  it('returns false for anything else', () => {
    expect(isBuiltinScopeId('acme-corp')).toBe(false);
    expect(isBuiltinScopeId('globex-industries')).toBe(false);
    expect(isBuiltinScopeId('')).toBe(false);
    expect(isBuiltinScopeId('Global')).toBe(false); // case-sensitive
  });

  it('BUILTIN_SCOPE_IDS exposes exactly the three ids', () => {
    expect([...BUILTIN_SCOPE_IDS]).toEqual(['global', 'organisation', 'industry']);
  });
});
