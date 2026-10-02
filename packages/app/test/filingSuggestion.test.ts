import { describe, expect, it, vi } from 'vitest';
import {
  buildFilingMessages,
  parseFilingSuggestion,
  suggestFiling,
  TRANSCRIPT_HEAD_CHARS,
  type FilingCandidate,
  type FilingTypeCandidate,
} from '../src/main/filingSuggestion.js';
import { assertFileRecordingPayload, filingNeedsResummary } from '../src/shared/filing.js';
import type { OllamaClient } from '../src/main/ollama.js';

const clients: FilingCandidate[] = [
  { id: 'hsbc', name: 'HSBC' },
  { id: 'acme', name: 'Acme Ltd' },
];
const types: FilingTypeCandidate[] = [
  { id: 'client-call', name: 'Client call', prompt: 'Summarise a call with a client.' },
  { id: 'internal', name: 'Internal sync', prompt: 'Summarise an internal team meeting.' },
];
const input = { title: 'Weekly Sync', durationSeconds: 1800, transcript: 'Hi all, thanks for joining from HSBC.' };

function parse(content: string) {
  return parseFilingSuggestion(content, ['C1', 'C2'], ['T1', 'T2'], clients, types);
}

describe('buildFilingMessages', () => {
  it('labels clients C1… and types T1… and includes title, duration and transcript', () => {
    const { clientLabels, typeLabels, messages } = buildFilingMessages(input, clients, types);
    expect(clientLabels).toEqual(['C1', 'C2']);
    expect(typeLabels).toEqual(['T1', 'T2']);
    const user = messages[1].content;
    expect(user).toContain('Recording: "Weekly Sync"');
    expect(user).toContain('Duration: 30 minutes');
    expect(user).toContain('C1: HSBC');
    expect(user).toContain('T2: Internal sync — Summarise an internal team meeting.');
    expect(user).toContain('thanks for joining from HSBC');
    expect(user).not.toContain('opening only');
  });

  it('sends only the opening of a long transcript and says so', () => {
    const long = 'a'.repeat(TRANSCRIPT_HEAD_CHARS) + 'TAIL';
    const user = buildFilingMessages({ ...input, transcript: long }, clients, types).messages[1].content;
    expect(user).toContain('Transcript (opening only):');
    expect(user).not.toContain('TAIL');
  });

  it('states plainly when there are no clients yet', () => {
    const user = buildFilingMessages(input, [], types).messages[1].content;
    expect(user).toContain('(no clients yet)');
  });
});

describe('parseFilingSuggestion', () => {
  it('maps labels back to ids', () => {
    expect(parse('{"client":"C1","type":"T2","confidence":"high","reason":"Names HSBC."}')).toEqual({
      clientId: 'hsbc',
      meetingTypeId: 'internal',
      confidence: 'high',
      reason: 'Names HSBC.',
    });
  });

  it('treats "none" or an unknown client label as no client, not a guess', () => {
    expect(parse('{"client":"none","type":"T1","confidence":"low"}')?.clientId).toBeNull();
    expect(parse('{"client":"C9","type":"T1","confidence":"low"}')?.clientId).toBeNull();
  });

  it('accepts fenced JSON and case differences', () => {
    expect(parse('```json\n{"client":"c2","type":"t1","confidence":"medium"}\n```')).toMatchObject({
      clientId: 'acme',
      meetingTypeId: 'client-call',
    });
  });

  it('returns null without a usable meeting type', () => {
    expect(parse('{"client":"C1","type":"T7","confidence":"high"}')).toBeNull();
    expect(parse('{"client":"C1","confidence":"high"}')).toBeNull();
    expect(parse('not json')).toBeNull();
  });

  it('downgrades an unrecognised confidence to low', () => {
    expect(parse('{"client":"C1","type":"T1","confidence":"certain"}')?.confidence).toBe('low');
  });
});

describe('suggestFiling', () => {
  it('asks the model with a schema at temperature 0 and parses the reply', async () => {
    const chat = vi.fn().mockResolvedValue({
      model: 'm',
      message: { role: 'assistant', content: '{"client":"C2","type":"T1","confidence":"medium","reason":"r"}' },
    });
    const result = await suggestFiling(
      input,
      clients,
      types,
      { chat } as unknown as OllamaClient,
      { model: 'qwen', keepAlive: '5m' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ clientId: 'acme', meetingTypeId: 'client-call' });
    const req = chat.mock.calls[0][0];
    expect(req.model).toBe('qwen');
    expect(req.options.temperature).toBe(0);
    expect(req.format).toBeDefined();
  });
});

describe('filing helpers', () => {
  it('re-summarises only when the meeting type changes', () => {
    expect(filingNeedsResummary('internal', 'internal')).toBe(false);
    expect(filingNeedsResummary('internal', 'client-call')).toBe(true);
    expect(filingNeedsResummary(null, 'client-call')).toBe(true);
  });

  it('validates the filing payload', () => {
    expect(assertFileRecordingPayload({ recordingId: 'r', clientId: 'c', meetingTypeId: 't' })).toEqual({
      recordingId: 'r',
      clientId: 'c',
      meetingTypeId: 't',
    });
    expect(() => assertFileRecordingPayload({ recordingId: 'r', clientId: '', meetingTypeId: 't' })).toThrow(
      'clientId',
    );
    expect(() => assertFileRecordingPayload(null)).toThrow();
  });
});
