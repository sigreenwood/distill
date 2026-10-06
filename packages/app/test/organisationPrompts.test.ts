import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrate, State } from '../src/main/state.js';
import { defaultMeetingTypeIds, meetingTypesForOrganisation, parseMeetingTypeIds } from '../src/shared/meetingTypeLine.js';
import { buildFilingMessages } from '../src/main/filingSuggestion.js';

const types = [
  { id: 'customer', name: 'Customer call', prompt: 'Customer prompt', retired: false },
  { id: 'club-agm', name: 'Club · AGM', prompt: 'AGM prompt', retired: false },
  { id: 'club-committee', name: 'Club · Committee meeting', prompt: 'Committee prompt', retired: false },
  { id: 'old-club', name: 'Old club prompt', prompt: 'Old', retired: true },
];

describe('organisation prompt choices', () => {
  it('limits LADFFA to AGM and Committee while leaving unrestricted organisations unchanged', () => {
    expect(meetingTypesForOrganisation(types, { meetingTypeIds: defaultMeetingTypeIds(' LADFFA ') }).map(t => t.id))
      .toEqual(['club-agm', 'club-committee']);
    expect(meetingTypesForOrganisation(types, { meetingTypeIds: defaultMeetingTypeIds('HSBC') }).map(t => t.id))
      .toEqual(['customer', 'club-agm', 'club-committee']);
  });

  it('does not widen an empty list, unavailable IDs or retired-only choices', () => {
    for (const meetingTypeIds of [[], ['missing'], ['old-club']]) {
      expect(meetingTypesForOrganisation(types, { meetingTypeIds })).toEqual([]);
    }
  });

  it('does not widen corrupted saved restrictions to all prompts', () => {
    expect(parseMeetingTypeIds(null)).toBeNull();
    expect(parseMeetingTypeIds('["club-agm"]')).toEqual(['club-agm']);
    expect(parseMeetingTypeIds('bad json')).toEqual([]);
    expect(parseMeetingTypeIds('[1]')).toEqual([]);
  });

  it('tells the filing classifier which type labels are allowed per organisation', () => {
    const messages = buildFilingMessages({ title: 'Meeting', durationSeconds: 60, transcript: 'Minutes' }, [
      { id: 'ladffa', name: 'LADFFA', meetingTypeIds: ['club-agm', 'club-committee'] },
      { id: 'hsbc', name: 'HSBC' },
    ], types.slice(0, 3)).messages;
    expect(messages[1].content).toContain('C1: LADFFA — allowed meeting types: T2, T3');
    expect(messages[1].content).not.toContain('C2: HSBC — allowed');
    expect(messages[0].content).toContain('Never choose a type outside its allowed list');
  });
});

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  const adapter = {
    exec: db.exec.bind(db), prepare: db.prepare.bind(db),
    transaction: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
      db.exec('BEGIN');
      try { const result = fn(...args); db.exec('COMMIT'); return result; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  } as unknown as ConstructorParameters<typeof State>[0];
  return { db, adapter, state: new State(adapter) };
}

describe('organisation prompt storage', () => {
  it('migrates fresh databases and persists choices without overwriting account context', () => {
    const { adapter, state } = database();
    migrate(adapter);
    state.upsertClient({ id: 'ladffa', name: 'LADFFA', is_builtin: 0, sort_order: 1 });
    state.setClientContext('ladffa', 'Club officers and standing agenda');
    expect(parseMeetingTypeIds(state.getClient('ladffa')!.meeting_type_ids_json)).toEqual(['club-agm', 'club-committee']);
    state.setClientMeetingTypes('ladffa', ['club-agm']);
    expect(parseMeetingTypeIds(state.getClient('ladffa')!.meeting_type_ids_json)).toEqual(['club-agm']);
    expect(state.getClient('ladffa')!.context).toBe('Club officers and standing agenda');
    state.upsertClient({ id: 'ladffa', name: 'LADFFA', is_builtin: 0, sort_order: 2 });
    expect(parseMeetingTypeIds(state.getClient('ladffa')!.meeting_type_ids_json)).toEqual(['club-agm']);
    state.setClientMeetingTypes('ladffa', null);
    migrate(adapter);
    expect(state.getClient('ladffa')!.meeting_type_ids_json).toBeNull();
  });

  it('upgrades existing LADFFA clients, recognises custom AGM IDs, and leaves other organisations alone', () => {
    const { db, adapter, state } = database();
    db.exec(`CREATE TABLE migrations (version INTEGER PRIMARY KEY, applied_at INTEGER);
      CREATE TABLE clients (id TEXT, name TEXT);
      CREATE TABLE meeting_types (id TEXT, name TEXT);
      INSERT INTO clients VALUES ('club', ' LADFFA '), ('hsbc', 'HSBC');
      INSERT INTO meeting_types VALUES ('custom-agm', 'AGM'), ('business', 'Customer call');`);
    for (let version = 1; version <= 20; version++) db.prepare('INSERT INTO migrations VALUES (?, 0)').run(version);
    migrate(adapter);
    expect(parseMeetingTypeIds(state.getClient('club')!.meeting_type_ids_json)).toEqual(expect.arrayContaining(['club-agm', 'club-committee', 'custom-agm']));
    expect(state.getClient('hsbc')!.meeting_type_ids_json).toBeNull();
    state.setClientMeetingTypes('club', []);
    migrate(adapter);
    expect(parseMeetingTypeIds(state.getClient('club')!.meeting_type_ids_json)).toEqual([]);
  });
});


describe('filing classification respects organisation choices', () => {
  async function classify(type: string, allowed: string[], calendarFallback = false) {
    const { classifyForFiling } = await import('../src/main/pipelineSteps.js');
    const updates: Record<string, unknown>[] = [];
    const row = {
      id: 'recording', filename: 'LADFFA minutes', source: 'local', duration_seconds: 60,
      attendees_json: null,
      calendar_match_json: calendarFallback ? JSON.stringify({
        meetingId: 'cal', subject: 'LADFFA AGM', startMs: 0, endMs: 3600000,
        attendees: [], body: null, organiser: null, alternatives: [],
      }) : null,
    };
    const state = {
      listMeetingTypes: () => types,
      listClients: () => [{ id: 'ladffa', name: 'LADFFA', meeting_type_ids_json: JSON.stringify(allowed) }],
      updateRecording: (_id: string, patch: Record<string, unknown>) => updates.push(patch),
    };
    const ctx = {
      state, getConfig: () => ({ ollama: { model: 'local', keepAlive: '5m' } }),
      logger: { info: vi.fn() },
      ollama: { chat: vi.fn().mockResolvedValue({ message: { content: JSON.stringify({
        client: calendarFallback ? 'none' : 'C1', type, confidence: 'high', reason: 'Club meeting',
      }) } }) },
    };
    await classifyForFiling(row as never, 'Minutes of the AGM', new AbortController().signal, ctx as never);
    return updates.at(-1);
  }

  it('keeps a permitted type and confidence', async () => {
    expect(await classify('T2', ['club-agm', 'club-committee'])).toMatchObject({
      suggested_client_id: 'ladffa', meeting_type_id: 'club-agm', filing_confidence: 'high',
    });
  });
  it('replaces a disallowed model choice with an allowed prompt and requires low-confidence review', async () => {
    expect(await classify('T1', ['club-agm', 'club-committee'])).toMatchObject({
      suggested_client_id: 'ladffa', meeting_type_id: 'club-agm', filing_confidence: 'low',
    });
  });
  it('also restricts the prompt when the organisation comes from the calendar fallback', async () => {
    expect(await classify('T1', ['club-agm'], true)).toMatchObject({
      suggested_client_id: 'ladffa', meeting_type_id: 'club-agm', filing_confidence: 'low',
    });
  });
  it('does not use an unrelated prompt if none of the allowed ones is installed', async () => {
    await expect(classify('T1', ['missing'])).rejects.toThrow('No active meeting prompts are allowed for LADFFA');
  });
});
