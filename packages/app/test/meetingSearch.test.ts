import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findExcerpts, markdownContent, matchesTerm, parseTerms, searchMeetings, validateSearch } from '../src/main/meetingSearch.js';
import { OllamaClient } from '../src/main/ollama.js';
import type { JoinedRecordingRow } from '../src/main/state.js';
import type { OllamaConfig } from '../src/main/config.js';

const config = { host: 'http://localhost:11434', model: 'local-model', keepAlive: '5m' } as OllamaConfig;
const rows = [
  { id: '1', filename: 'HSBC call', client_name: 'HSBC', summary_text: 'Discussed budgets.', transcript_text: '[01:00] Sam: Disaster recovery testing is due.', synced_at: 1 },
  { id: '2', filename: 'HSBC review', client_name: 'HSBC', summary_text: 'DR planning.', transcript_text: null, synced_at: 2 },
] as JoinedRecordingRow[];

describe('meeting search', () => {
  it('requires both company and topic and respects acronym boundaries', () => {
    expect(findExcerpts('disaster recovery testing', 'HSBC', [['hsbc'], ['dr', 'disaster recovery']])).toEqual(['disaster recovery testing']);
    expect(findExcerpts('disaster recovery', 'Other bank', [['hsbc'], ['dr', 'disaster recovery']])).toBeNull();
    expect(matchesTerm('address changes', 'dr')).toBe(-1);
  });
  it('keeps exported transcripts out of summary searches', () => {
    const md = '---\nclient: HSBC\n---\n# call\n\n## Summary\n\nBudgets.\n\n---\n\n## Transcript\n\nDR testing.';
    expect(markdownContent(md, 'summary')).toBe('Budgets.');
    expect(markdownContent(md, 'transcript')).toBe('DR testing.');
    expect(markdownContent('## Summary\nBudgets.', 'transcript')).toBeNull();
  });
  it('validates IPC input and model output', () => {
    expect(() => validateSearch('', 'summary')).toThrow();
    expect(() => validateSearch('HSBC', 'all')).toThrow();
    expect(() => parseTerms('[[]]')).toThrow();
    expect(() => parseTerms('[[123]]')).toThrow();
    expect(parseTerms('```json\n[["HSBC"],["DR","disaster recovery"]]\n```')).toEqual([['hsbc'], ['dr', 'disaster recovery']]);
  });
  it('searches only the requested source and reports unavailable transcripts', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({ message: { role: 'assistant', content: '[["HSBC"],["DR","disaster recovery"]]' } } as never);
    try {
      const summary = await searchMeetings(rows, 'HSBC DR', 'summary', config);
      expect(summary.results.map(r => r.id)).toEqual(['2']);
      const transcript = await searchMeetings(rows, 'HSBC DR', 'transcript', config);
      expect(transcript.results.map(r => r.id)).toEqual(['1']);
      expect(transcript.results[0].source).toBe('transcript');
      expect(transcript.unavailable).toBe(1);
      expect(transcript.searched).toBe(1);
    } finally { spy.mockRestore(); }
  });
  it('falls back visibly when Ollama is unavailable', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockRejectedValue(new Error('offline'));
    try {
      const result = await searchMeetings(rows, 'a call with HSBC that talked about DR?', 'summary', config);
      expect(result.results.map(r => r.id)).toEqual(['2']);
      expect(result.warning).toContain('exact keyword');
    } finally { spy.mockRestore(); }
  });
  it('rejects remote inference configurations', async () => {
    await expect(searchMeetings(rows, 'HSBC', 'summary', { ...config, host: 'https://example.com' })).rejects.toThrow('local');
    await expect(searchMeetings(rows, 'HSBC', 'summary', { ...config, model: 'model:cloud' })).rejects.toThrow('local');
    await expect(searchMeetings(rows, 'HSBC', 'summary', { ...config, host: 'ftp://localhost' })).rejects.toThrow('local');
  });
  it('requests structured concepts and sends only the question to Ollama', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({ message: { content: '[["HSBC"]]' } } as never);
    try {
      await searchMeetings(rows, 'HSBC', 'summary', config);
      expect(spy).toHaveBeenCalledOnce();
      const request = spy.mock.calls[0][0];
      expect(request.format).toMatchObject({ type: 'array', maxItems: 12 });
      expect(request.messages.filter(m => m.role === 'user')).toEqual([{ role: 'user', content: 'HSBC' }]);
      expect(JSON.stringify(request)).not.toContain('Discussed budgets.');
      expect(JSON.stringify(request)).not.toContain('Disaster recovery testing is due.');
    } finally { spy.mockRestore(); }
  });
  it('does not read transcripts or fall back to them when summaries have no matches', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({ message: { content: '[["unmatched"]]' } } as never);
    const row = { ...rows[0], get transcript_text(): string { throw new Error('Transcript must remain unread'); } };
    try {
      const result = await searchMeetings([row], 'unmatched', 'summary', config);
      expect(result.totalMatches).toBe(0);
      expect(result.scope).toBe('summary');
    } finally { spy.mockRestore(); }
  });
  it('searches known Markdown exports and counts missing source content', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'distill-search-'));
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({ message: { content: '[["HSBC"],["DR"]]' } } as never);
    try {
      const file = path.join(dir, 'meeting.md');
      await fs.writeFile(file, '# Meeting\n\n## Summary\nBudgets.\n\n---\n\n## Transcript\nDR testing.');
      const imported = { ...rows[0], summary_text: null, transcript_text: null, markdown_path: file, status: 'skipped' as const };
      const missing = { ...imported, id: 'missing', markdown_path: path.join(dir, 'missing.md') };
      const summary = await searchMeetings([imported, missing], 'HSBC DR', 'summary', config);
      expect(summary.totalMatches).toBe(0);
      expect(summary.unavailable).toBe(1);
      const transcript = await searchMeetings([imported, missing], 'HSBC DR', 'transcript', config);
      expect(transcript.results.map(r => r.id)).toEqual(['1']);
      expect(transcript.results[0].excerpts).toEqual(['DR testing.']);
      expect(transcript.unavailable).toBe(1);
    } finally {
      spy.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it('falls back on invalid model output and strips punctuation before filler words', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({ message: { content: 'not valid JSON' } } as never);
    try {
      const result = await searchMeetings(rows, 'Please, find HSBC DR.', 'summary', config);
      expect(result.results.map(r => r.id)).toEqual(['2']);
      expect(result.warning).toContain('exact keyword');
      await expect(searchMeetings(rows, 'Please, find!', 'summary', config)).rejects.toThrow('company name or topic');
    } finally { spy.mockRestore(); }
  });
});
