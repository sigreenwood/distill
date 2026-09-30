import { describe, expect, it, vi } from 'vitest';
import { buildVersionList, generateSummaryVersion } from '../src/main/summaryVersions.js';
import { OllamaClient } from '../src/main/ollama.js';
import type { SummaryVersionRow } from '../src/main/state.js';
import type { OllamaConfig } from '../src/main/config.js';

const config: OllamaConfig = {
  host: 'http://localhost:11434', model: 'qwen3.8:27b-mlx', contextWindow: 65536, temperature: 0, keepAlive: '5m',
};
const version = (patch: Partial<SummaryVersionRow> = {}): SummaryVersionRow => ({
  id: 'v1', recording_id: 'r1', summary_text: 'Historical summary', model: 'qwen3.6:27b',
  prompt_snapshot: 'Summarise this.', meeting_type_name: 'Client call', is_active: 0, created_at: 1,
  ...patch,
});

describe('buildVersionList', () => {
  it('marks the matching historical row active and does not synthesise a duplicate', () => {
    const row = { summary_text: 'Current summary', model_snapshot: 'qwen3.6:27b', meeting_type_name: 'Client call', updated_at: 2 };
    const historical = [version({ id: 'v1', summary_text: 'Current summary', is_active: 1 })];
    const list = buildVersionList(row, historical);
    expect(list).toEqual([{
      id: 'v1', summaryText: 'Current summary', model: 'qwen3.6:27b',
      meetingTypeName: 'Client call', isActive: true, createdAt: 1,
    }]);
  });

  it('synthesises a "current" entry when the live summary has no matching logged version', () => {
    // Covers recordings summarised before this feature existed: no version
    // rows at all, so the live summary must still show up as one.
    const row = { summary_text: 'Pre-feature summary', model_snapshot: 'qwen2.5:32b', meeting_type_name: 'Training', updated_at: 5 };
    const list = buildVersionList(row, []);
    expect(list).toEqual([{
      id: 'current', summaryText: 'Pre-feature summary', model: 'qwen2.5:32b',
      meetingTypeName: 'Training', isActive: true, createdAt: 5,
    }]);
  });

  it('demotes a stale active row and synthesises current when a correction has since cleared history out of sync', () => {
    const row = { summary_text: 'New summary after correction', model_snapshot: 'qwen3.6:27b', meeting_type_name: 'Client call', updated_at: 9 };
    const historical = [version({ id: 'old', summary_text: 'Superseded summary', is_active: 1, created_at: 3 })];
    const list = buildVersionList(row, historical);
    expect(list.find(v => v.id === 'current')).toMatchObject({ isActive: true, summaryText: 'New summary after correction' });
    expect(list.find(v => v.id === 'old')).toMatchObject({ isActive: false });
  });

  it('sorts historical versions newest first and handles no live summary', () => {
    const row = { summary_text: null, model_snapshot: null, meeting_type_name: null, updated_at: 1 };
    const historical = [version({ id: 'a', created_at: 1 }), version({ id: 'b', created_at: 5 })];
    expect(buildVersionList(row, historical).map(v => v.id)).toEqual(['b', 'a']);
  });
});

describe('generateSummaryVersion', () => {
  const input = {
    transcriptText: 'Meeting text.', attendeesJson: null,
    meetingType: { name: 'Client call', prompt: 'Summarise this meeting.' }, model: 'qwen3.6:27b',
  };

  it('refuses a remote host or a cloud model before sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      generateSummaryVersion(input, { ...config, host: 'http://10.0.0.5:11434' }, new AbortController().signal),
    ).rejects.toThrow(/local Ollama/);
    await expect(
      generateSummaryVersion({ ...input, model: 'gpt-oss:120b-cloud' }, config, new AbortController().signal),
    ).rejects.toThrow(/local Ollama/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns the trimmed summary and the responding model, with no warning under budget', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '  A tidy summary.  ' }, model: 'qwen3.6:27b',
    } as never);
    try {
      const result = await generateSummaryVersion(input, config, new AbortController().signal);
      expect(result).toEqual({ summaryText: 'A tidy summary.', model: 'qwen3.6:27b', warning: null });
    } finally { spy.mockRestore(); }
  });

  it('warns when the transcript is likely to exceed the context budget', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({
      message: { content: 'Summary.' }, model: 'qwen3.6:27b',
    } as never);
    try {
      const huge = { ...input, transcriptText: 'x'.repeat(config.contextWindow * 4) };
      const result = await generateSummaryVersion(huge, config, new AbortController().signal);
      expect(result.warning).toMatch(/truncated/);
    } finally { spy.mockRestore(); }
  });

  it('throws on an empty response rather than logging a blank version', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({
      message: { content: '   ' }, model: 'qwen3.6:27b',
    } as never);
    try {
      await expect(generateSummaryVersion(input, config, new AbortController().signal)).rejects.toThrow(/empty/);
    } finally { spy.mockRestore(); }
  });
});
