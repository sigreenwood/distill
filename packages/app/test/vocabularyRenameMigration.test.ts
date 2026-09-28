import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateScopeRenames } from '../src/main/vocabulary.js';

/**
 * Tests for migrateScopeRenames \u2014 the rename migration that converts
 * pre-rename teradata.json / ai.json to organisation.json / industry.json
 * in the user-writable vocabulary directory.
 *
 * Exercises three scenarios per mapping:
 *   - old exists, new doesn't \u2192 rename
 *   - both exist \u2192 keep new, delete old
 *   - neither exists \u2192 no-op
 *
 * Plus the dir-doesn't-exist case (fresh install) where the helper
 * exits cleanly without throwing.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'distill-rename-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateScopeRenames', () => {
  it('renames teradata.json to organisation.json when only the old exists', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'teradata.json'),
      JSON.stringify({ whisperHints: ['Term1'], replacements: [] }),
    );

    const result = migrateScopeRenames(userDir);

    expect(result.renamed).toContain('teradata.json -> organisation.json');
    expect(existsSync(join(userDir, 'teradata.json'))).toBe(false);
    expect(existsSync(join(userDir, 'organisation.json'))).toBe(true);
    // Content preserved through the rename.
    const moved = JSON.parse(
      readFileSync(join(userDir, 'organisation.json'), 'utf-8'),
    );
    expect(moved.whisperHints).toEqual(['Term1']);
  });

  it('renames ai.json to industry.json when only the old exists', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'ai.json'),
      JSON.stringify({ whisperHints: ['Tensor'], replacements: [] }),
    );

    const result = migrateScopeRenames(userDir);

    expect(result.renamed).toContain('ai.json -> industry.json');
    expect(existsSync(join(userDir, 'ai.json'))).toBe(false);
    expect(existsSync(join(userDir, 'industry.json'))).toBe(true);
  });

  it('handles both renames in one call', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'teradata.json'),
      JSON.stringify({ whisperHints: ['A'], replacements: [] }),
    );
    writeFileSync(
      join(userDir, 'ai.json'),
      JSON.stringify({ whisperHints: ['B'], replacements: [] }),
    );

    const result = migrateScopeRenames(userDir);

    expect(result.renamed.length).toBe(2);
    expect(existsSync(join(userDir, 'organisation.json'))).toBe(true);
    expect(existsSync(join(userDir, 'industry.json'))).toBe(true);
  });

  it('keeps new and deletes old when both exist', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    // The old one — represents legacy data.
    writeFileSync(
      join(userDir, 'teradata.json'),
      JSON.stringify({ whisperHints: ['old'], replacements: [] }),
    );
    // The new one — represents already-migrated or imported.
    writeFileSync(
      join(userDir, 'organisation.json'),
      JSON.stringify({ whisperHints: ['new'], replacements: [] }),
    );

    const result = migrateScopeRenames(userDir);

    expect(result.renamed).not.toContain('teradata.json -> organisation.json');
    expect(result.deletedDuplicates).toContain('teradata.json');
    expect(existsSync(join(userDir, 'teradata.json'))).toBe(false);
    expect(existsSync(join(userDir, 'organisation.json'))).toBe(true);
    // The "new" file's content is preserved (we kept new, not old).
    const surviving = JSON.parse(
      readFileSync(join(userDir, 'organisation.json'), 'utf-8'),
    );
    expect(surviving.whisperHints).toEqual(['new']);
  });

  it('is a no-op when neither old name exists', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'global.json'),
      JSON.stringify({ whisperHints: [], replacements: [] }),
    );

    const result = migrateScopeRenames(userDir);

    expect(result.renamed).toEqual([]);
    expect(result.deletedDuplicates).toEqual([]);
    // global.json untouched.
    expect(existsSync(join(userDir, 'global.json'))).toBe(true);
  });

  it('returns cleanly when the user dir does not exist (fresh install)', () => {
    const userDir = join(tmp, 'never-created');

    const result = migrateScopeRenames(userDir);

    expect(result.renamed).toEqual([]);
    expect(result.deletedDuplicates).toEqual([]);
    // Helper does not create the dir; that's the next migration's job.
    expect(existsSync(userDir)).toBe(false);
  });

  it('is idempotent across repeated calls', () => {
    const userDir = join(tmp, 'vocabulary');
    mkdirSync(userDir);
    writeFileSync(
      join(userDir, 'teradata.json'),
      JSON.stringify({ whisperHints: [], replacements: [] }),
    );

    // First call does the rename.
    const r1 = migrateScopeRenames(userDir);
    expect(r1.renamed.length).toBe(1);

    // Second call should be a no-op (old gone, new in place).
    const r2 = migrateScopeRenames(userDir);
    expect(r2.renamed.length).toBe(0);
    expect(r2.deletedDuplicates.length).toBe(0);
  });
});
