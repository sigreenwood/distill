import { describe, expect, it, vi } from 'vitest';
import {
  buildSuggestionMessages,
  parseSuggestion,
  suggestMeetingType,
  type MeetingTypeCandidate,
} from '../src/main/meetingTypeSuggestion.js';
import { OllamaClient } from '../src/main/ollama.js';
import type { OllamaConfig } from '../src/main/config.js';
import type { Attendee } from '../src/shared/attendees.js';

const config: OllamaConfig = {
  host: 'http://localhost:11434', model: 'qwen3.8:27b-mlx', contextWindow: 65536,
  adaptiveContextWindow: true, temperature: 0, keepAlive: '5m',
};
const candidates: MeetingTypeCandidate[] = [
  { id: 'standup', name: 'Daily standup', prompt: 'Summarise a short daily team check-in.' },
  { id: 'qbr', name: 'Quarterly review', prompt: 'Summarise a formal quarterly business review with a client.' },
];
const attendee = (name: string, company: string | null = null): Attendee => ({ name, email: null, company });

describe('buildSuggestionMessages', () => {
  it('labels candidates T1, T2, … in order and includes the recording signals', () => {
    const { labels, messages } = buildSuggestionMessages(
      { title: 'Weekly Sync', durationSeconds: 900, clientName: 'Acme', attendees: [attendee('Sam', 'Acme')] },
      candidates,
    );
    expect(labels).toEqual(['T1', 'T2']);
    const user = messages[1].content;
    expect(user).toContain('Recording: "Weekly Sync"');
    expect(user).toContain('Duration: 15 minutes');
    expect(user).toContain('Client: Acme');
    expect(user).toContain('Sam (Acme)');
    expect(user).toContain('T1: Daily standup');
    expect(user).toContain('T2: Quarterly review');
  });

  it('reports unknown client and no attendees honestly rather than guessing', () => {
    const { messages } = buildSuggestionMessages(
      { title: 'Untitled', durationSeconds: null, clientName: null, attendees: [] },
      candidates,
    );
    const user = messages[1].content;
    expect(user).toContain('Duration: unknown');
    expect(user).toContain('Client: not yet selected');
    expect(user).toContain('Attendees (0): none pasted yet');
  });
});

describe('parseSuggestion', () => {
  const labels = ['T1', 'T2'];

  it('maps a valid label back to the candidate id, case-insensitively', () => {
    const result = parseSuggestion('{"type":"t2","confidence":"high","reason":"Client-facing and quarterly."}', labels, candidates);
    expect(result).toEqual({ meetingTypeId: 'qbr', confidence: 'high', reason: 'Client-facing and quarterly.' });
  });

  it('accepts fenced JSON', () => {
    const result = parseSuggestion('```json\n{"type":"T1","confidence":"medium"}\n```', labels, candidates);
    expect(result).toEqual({ meetingTypeId: 'standup', confidence: 'medium', reason: '' });
  });

  it('drops a label outside the given set rather than guessing the closest one', () => {
    expect(parseSuggestion('{"type":"T9","confidence":"high"}', labels, candidates)).toBeNull();
  });

  it('defaults an invalid confidence to low rather than rejecting the whole suggestion', () => {
    const result = parseSuggestion('{"type":"T1","confidence":"certain"}', labels, candidates);
    expect(result?.confidence).toBe('low');
  });

  it('returns null on non-JSON rather than throwing', () => {
    expect(parseSuggestion('Sure, I think T1.', labels, candidates)).toBeNull();
  });
});

describe('suggestMeetingType', () => {
  const input = { title: 'Weekly Sync', durationSeconds: 900, clientName: null, attendees: [] };

  it('returns null without calling Ollama when there are fewer than two candidates', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat');
    try {
      expect(await suggestMeetingType(input, [candidates[0]], config, new AbortController().signal)).toBeNull();
      expect(await suggestMeetingType(input, [], config, new AbortController().signal)).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

  it('refuses a remote host or a cloud model before sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      suggestMeetingType(input, candidates, { ...config, host: 'http://10.0.0.5:11434' }, new AbortController().signal),
    ).rejects.toThrow(/local Ollama/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns the parsed suggestion from a well-formed response', async () => {
    const spy = vi.spyOn(OllamaClient.prototype, 'chat').mockResolvedValue({
      message: { role: 'assistant', content: '{"type":"T2","confidence":"high","reason":"Sounds like a QBR."}' },
    } as never);
    try {
      const result = await suggestMeetingType(input, candidates, config, new AbortController().signal);
      expect(result).toEqual({ meetingTypeId: 'qbr', confidence: 'high', reason: 'Sounds like a QBR.' });
    } finally { spy.mockRestore(); }
  });
});
