import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProcessedElsewhereIds } from '../src/main/processedElsewhere.js';

/**
 * Tests for the cross-machine completion lookup. The lookup scans a
 * Markdown output base directory recursively (one level deep into
 * client subfolders), parses YAML frontmatter from each `.md` file,
 * and returns a Map keyed by recording_id of files distill produced.
 *
 * Test strategy: build small temp directories with hand-rolled
 * markdown files, exercise the loader, assert on the resulting Map.
 * No mocking of fs — we use real disk via a fresh tmpdir per test
 * so behaviour matches what production sees on the user's iCloud
 * Drive folder.
 */

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'distill-pe-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeMd(relPath: string, body: string, mtime?: number): string {
  const full = join(tmp, relPath);
  mkdirSync(join(tmp, relPath, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  if (mtime !== undefined) {
    const t = mtime / 1000; // utimesSync wants seconds
    utimesSync(full, t, t);
  }
  return full;
}

describe('loadProcessedElsewhereIds', () => {
  describe('empty / missing inputs', () => {
    it('returns an empty Map for a nonexistent directory', async () => {
      const result = await loadProcessedElsewhereIds(join(tmp, 'does-not-exist'));
      expect(result.size).toBe(0);
    });

    it('returns an empty Map for an empty directory', async () => {
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });

    it('returns an empty Map when the dir contains only non-md files', async () => {
      writeMd('readme.txt', 'not markdown');
      writeMd('image.png', 'fake image');
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });
  });

  describe('basic frontmatter extraction', () => {
    it('finds a single recording at the top level', async () => {
      writeMd(
        'note.md',
        '---\nrecording_id: abc123\nmodel: "qwen2.5:32b"\n---\n# title\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(1);
      const rec = result.get('abc123');
      expect(rec).toBeDefined();
      expect(rec?.modelSnapshot).toBe('qwen2.5:32b');
    });

    it('finds recordings inside a one-level client subfolder', async () => {
      writeMd(
        'Acme Corp/2026-04-22 - Acme Corp - Some Meeting.md',
        '---\nrecording_id: 5b4bb64327288abd073b33ef8a9ddc61\nmodel: "qwen2.5:32b"\nwhisper_model: "mlx-community/whisper-large-v3-mlx"\n---\n',
      );
      writeMd(
        'Globex Industries/2026-04-23 - Globex - Other.md',
        '---\nrecording_id: aaaa1111\nmodel: "qwen2.5:14b"\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(2);
      expect(result.get('5b4bb64327288abd073b33ef8a9ddc61')?.modelSnapshot).toBe(
        'qwen2.5:32b',
      );
      expect(result.get('aaaa1111')?.modelSnapshot).toBe('qwen2.5:14b');
    });

    it('captures the markdown file path for use as markdown_path', async () => {
      const path = writeMd(
        'Acme Corp/file.md',
        '---\nrecording_id: id-with-path\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.get('id-with-path')?.markdownPath).toBe(path);
    });

    it('captures the file mtime as writtenAtMs', async () => {
      const targetMtime = 1735000000000;
      writeMd(
        'Acme Corp/file.md',
        '---\nrecording_id: id-with-mtime\n---\n',
        targetMtime,
      );
      const result = await loadProcessedElsewhereIds(tmp);
      // utimesSync resolution can be 1s or 1ms depending on filesystem; just
      // verify it's close to what we asked for.
      const writtenAt = result.get('id-with-mtime')?.writtenAtMs;
      expect(writtenAt).toBeDefined();
      expect(Math.abs((writtenAt ?? 0) - targetMtime)).toBeLessThan(1000);
    });

    it('returns null for missing model fields rather than throwing', async () => {
      writeMd(
        'Acme Corp/file.md',
        '---\nrecording_id: id-no-model\nfilename: "Foo"\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      const rec = result.get('id-no-model');
      expect(rec?.modelSnapshot).toBeNull();
      expect(rec?.whisperSnapshot).toBeNull();
    });
  });

  describe('files we should ignore', () => {
    it('ignores .md files without frontmatter', async () => {
      writeMd('Acme Corp/random-note.md', '# Just a note\nno frontmatter here\n');
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });

    it('ignores frontmatter without a recording_id', async () => {
      writeMd(
        'Acme Corp/user-note.md',
        '---\ntitle: "My note"\nauthor: "Author"\n---\nbody\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });

    it('ignores non-markdown extensions', async () => {
      writeMd(
        'Acme Corp/file.html',
        '<html>\n<!-- recording_id: ignored-html -->\n</html>',
      );
      writeMd(
        'Acme Corp/file.txt',
        '---\nrecording_id: ignored-txt\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });

    it('does not recurse beyond client subfolders', async () => {
      // distill writes to baseDir/<client>/<file>.md, never deeper.
      // A file two levels deep is probably the user's own structure
      // and should not be picked up.
      writeMd(
        'Acme Corp/sub/deep.md',
        '---\nrecording_id: should-not-find\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(0);
    });
  });

  describe('conflict handling', () => {
    it('keeps the most recently modified file when two share a recording_id', async () => {
      const olderMtime = 1700000000000;
      const newerMtime = 1735000000000;
      writeMd(
        'Acme Corp/older.md',
        '---\nrecording_id: dup-id\nmodel: "qwen2.5:14b"\n---\n',
        olderMtime,
      );
      writeMd(
        'Acme Corp/newer.md',
        '---\nrecording_id: dup-id\nmodel: "qwen2.5:32b"\n---\n',
        newerMtime,
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(1);
      // The newer file wins, so its model is what we report.
      expect(result.get('dup-id')?.modelSnapshot).toBe('qwen2.5:32b');
    });
  });

  describe('frontmatter format tolerance', () => {
    it('handles frontmatter with both quoted and unquoted values', async () => {
      writeMd(
        'Acme Corp/file.md',
        '---\nrecording_id: unquoted-id\nmodel: "qwen2.5:32b"\nfilename: "Hello"\nduration_seconds: 1234\n---\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(1);
      const rec = result.get('unquoted-id');
      expect(rec?.modelSnapshot).toBe('qwen2.5:32b');
    });

    it('handles \\r\\n line endings as well as \\n', async () => {
      writeMd(
        'Acme Corp/file.md',
        '---\r\nrecording_id: crlf-id\r\nmodel: "qwen2.5:14b"\r\n---\r\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      expect(result.size).toBe(1);
      expect(result.get('crlf-id')?.modelSnapshot).toBe('qwen2.5:14b');
    });

    it('parses a real-world frontmatter sample from a client output', async () => {
      // Mirrors the actual frontmatter shape distill writes for
      // completed recordings. Generic client name ("Acme Corp") used
      // as a stand-in.
      writeMd(
        'Acme Corp/realistic.md',
        '---\n' +
          'recording_id: 5b4bb64327288abd073b33ef8a9ddc61\n' +
          'filename: "04-24 Meeting: Tooling Reliability and Strategy"\n' +
          'client: "Acme Corp"\n' +
          'meeting_type: "Client Call"\n' +
          'date: 2026-04-24T07:59:52.405Z\n' +
          'duration_seconds: 2103\n' +
          'model: "qwen2.5:32b"\n' +
          'whisper_model: "mlx-community/whisper-large-v3-mlx"\n' +
          'vocabulary_sources: "global.json,organisation.json,industry.json"\n' +
          'vocabulary_rules_applied: 2\n' +
          'transcript_embedded: true\n' +
          '---\n# header\n',
      );
      const result = await loadProcessedElsewhereIds(tmp);
      const rec = result.get('5b4bb64327288abd073b33ef8a9ddc61');
      expect(rec).toBeDefined();
      expect(rec?.modelSnapshot).toBe('qwen2.5:32b');
      expect(rec?.whisperSnapshot).toBe('mlx-community/whisper-large-v3-mlx');
    });
  });
});
