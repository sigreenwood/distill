import { describe, it, expect, vi } from 'vitest';
import { buildBriefMessages, generateClientBrief, parseBrief } from '../src/main/clientBrief.js';
import {
  BRIEF_MAX_MEETINGS,
  BRIEF_MAX_SUMMARY_CHARS,
  briefToMarkdown,
  checkBriefSelection,
  defaultBriefSelection,
  parseSavedBrief,
  savedBriefSummary,
  type BriefCandidate,
  type ClientBrief,
} from '../src/shared/brief.js';

const day = 86_400_000;
const cand = (id: string, date: number, summaryChars: number): BriefCandidate => ({
  id, title: id, date, meetingType: null, summaryChars,
});

describe('brief selection', () => {
  it('rejects empty, oversized and summary-less selections', () => {
    expect(checkBriefSelection([]).ok).toBe(false);
    expect(checkBriefSelection([cand('a', 1, 0)]).ok).toBe(false);
    expect(checkBriefSelection([cand('a', 1, BRIEF_MAX_SUMMARY_CHARS + 1)]).ok).toBe(false);
    const many = Array.from({ length: BRIEF_MAX_MEETINGS + 1 }, (_, i) => cand(`m${i}`, i, 10));
    expect(checkBriefSelection(many).ok).toBe(false);
    expect(checkBriefSelection([cand('a', 1, 10), cand('b', 2, 20)])).toEqual({ ok: true, chars: 30, reason: null });
  });

  it('pre-selects the newest meetings that have summaries and fit', () => {
    const list = [
      cand('new', 5 * day, 10_000),
      cand('nosummary', 4 * day, 0),
      cand('huge', 3 * day, BRIEF_MAX_SUMMARY_CHARS),
      cand('older', 2 * day, 10_000),
    ];
    expect(defaultBriefSelection(list)).toEqual(['new', 'older']);
    expect(defaultBriefSelection(list, 1)).toEqual(['new']);
  });
});

describe('buildBriefMessages', () => {
  it('numbers meetings oldest first and keeps summaries as labelled data', () => {
    const { refs, messages } = buildBriefMessages('AIB', [
      { id: 'b', title: 'Later call', date: Date.UTC(2026, 8, 20), meetingType: 'Client call', summary: 'Second.' },
      { id: 'a', title: 'First call', date: Date.UTC(2026, 8, 1), meetingType: null, summary: 'First.' },
    ]);
    expect(refs.map((r) => [r.ref, r.id])).toEqual([['M1', 'a'], ['M2', 'b']]);
    const user = messages[1].content;
    expect(user.indexOf('=== M1 · 2026-09-01 · First call ===')).toBeLessThan(
      user.indexOf('=== M2 · 2026-09-20 · Client call · Later call ==='),
    );
    expect(messages[0].content).toMatch(/never say whether it has been completed/);
  });
});

describe('parseBrief', () => {
  it('keeps only points citing a supplied meeting and counts the rest', () => {
    const content = JSON.stringify({
      decisions: [
        { text: 'Pilot on VantageCloud', sources: ['M1', 'm2'] },
        { text: 'Unsourced', sources: [] },
        { text: 'Made-up source', sources: ['M9'] },
      ],
      commitments: [{ text: 'Send pricing', owner: 'Teradata', sources: ['M2'] }, { text: 'No owner', owner: '', sources: ['M1'] }],
      openQuestions: [{ text: '', sources: ['M1'] }],
      suggestedQuestions: [{ text: 'Has pricing landed?', sources: ['M2', 'M2'] }],
    });
    const brief = parseBrief(content, ['M1', 'M2']);
    expect(brief.decisions).toEqual([{ text: 'Pilot on VantageCloud', sources: ['M1', 'M2'] }]);
    expect(brief.commitments).toEqual([
      { text: 'Send pricing', owner: 'Teradata', sources: ['M2'] },
      { text: 'No owner', owner: null, sources: ['M1'] },
    ]);
    expect(brief.openQuestions).toEqual([]);
    expect(brief.suggestedQuestions).toEqual([{ text: 'Has pricing landed?', sources: ['M2'] }]);
    expect(brief.dropped).toBe(3);
  });

  it('accepts fenced JSON and tolerates missing lists', () => {
    const brief = parseBrief('```json\n{"decisions":[{"text":"x","sources":["M1"]}]}\n```', ['M1']);
    expect(brief.decisions).toHaveLength(1);
    expect(brief.commitments).toEqual([]);
  });

  it('throws on non-JSON so the caller can report it', () => {
    expect(() => parseBrief('Here is your brief:', ['M1'])).toThrow();
  });
});

describe('generateClientBrief', () => {
  const meeting = { id: 'a', title: 'Call', date: 1, meetingType: null, summary: 'Text.' };
  const config = { host: 'http://localhost:11434', model: 'qwen3.8:27b-mlx', contextWindow: 65536, temperature: 0, keepAlive: '5m' };

  it('refuses a remote Ollama host or cloud model before sending anything', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      generateClientBrief('AIB', [meeting], { ...config, host: 'http://10.0.0.5:11434' }, new AbortController().signal),
    ).rejects.toThrow(/local Ollama/);
    await expect(
      generateClientBrief('AIB', [meeting], { ...config, model: 'gpt-oss:120b-cloud' }, new AbortController().signal),
    ).rejects.toThrow(/local Ollama/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('refuses an invalid selection before sending anything', async () => {
    await expect(generateClientBrief('AIB', [], config, new AbortController().signal)).rejects.toThrow(/Select at least one/);
  });
});

describe('briefToMarkdown', () => {
  it('labels inferred questions and uncertain commitments, and cites dated sources', () => {
    const brief: ClientBrief = {
      clientName: 'AIB',
      decisions: [{ text: 'Pilot agreed', sources: ['M1'] }],
      commitments: [{ text: 'Send pricing', owner: 'Teradata', sources: ['M1'] }],
      openQuestions: [],
      suggestedQuestions: [{ text: 'Has pricing landed?', sources: ['M1'] }],
      sources: [{ ref: 'M1', id: 'a', title: 'Kick-off', date: Date.UTC(2026, 8, 1) }],
      dropped: 0,
      model: 'qwen3.8:27b-mlx',
    };
    const md = briefToMarkdown(brief);
    expect(md).toContain('- Pilot agreed (M1 · 2026-09-01)');
    expect(md).toContain('## Commitments made (status not tracked)');
    expect(md).toContain('- **Teradata:** Send pricing (M1 · 2026-09-01)');
    expect(md).toContain('## Suggested questions (inferred, not stated)');
    expect(md).not.toContain('## Questions raised');
    expect(md).toContain('- M1: Kick-off (2026-09-01)');
  });
});

describe('saved briefs', () => {
  const brief: ClientBrief = {
    clientName: 'Acme',
    decisions: [{ text: 'D', sources: ['M1'] }],
    commitments: [{ text: 'C', sources: ['M2'], owner: null }],
    openQuestions: [],
    suggestedQuestions: [{ text: 'Q', sources: ['M1'] }],
    sources: [
      { ref: 'M1', id: 'a', title: 'One', date: 100 },
      { ref: 'M2', id: 'b', title: 'Two', date: 300 },
    ],
    dropped: 0,
    model: 'gemma',
  };

  it('round-trips through JSON and summarises for the list', () => {
    expect(parseSavedBrief(JSON.stringify(brief))).toEqual(brief);
    expect(savedBriefSummary(brief, 'id1', 999)).toEqual({ id: 'id1', savedAt: 999, model: 'gemma', meetings: 2, from: 100, to: 300, points: 3 });
  });

  it('rejects stored JSON that is not a brief', () => {
    expect(parseSavedBrief('not json')).toBeNull();
    expect(parseSavedBrief(JSON.stringify({ clientName: 'Acme' }))).toBeNull();
  });
});
