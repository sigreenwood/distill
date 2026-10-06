import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '../src/shared/ipcChannels.js';
import { registerIpcHandlers, type IpcContext } from '../src/main/ipc.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  importCalendarPdfs: vi.fn(),
  send: vi.fn(),
  info: vi.fn(),
  suggest: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  clipboard: {},
  shell: {},
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
}));
vi.mock('../src/main/calendar/service.js', () => ({ ensureCalendarMatch: () => null }));
vi.mock('../src/main/meetingTypeSuggestion.js', () => ({ suggestMeetingType: mocks.suggest }));
vi.mock('../src/main/bundledResources.js', () => ({ bundledCalendarScript: () => '/app/python/calendar_pdf.py' }));
vi.mock('../src/main/pipelineSteps.js', () => ({ resolvePythonBinary: () => '/app/venv/bin/python' }));
vi.mock('../src/main/state.js', () => ({}));
// Avoid importing paths.ts, whose module initialization can migrate real user directories.
vi.mock('../src/main/paths.js', () => ({
  appSupportDir: () => '/tmp/distill-calendar-ipc-test',
  configFile: () => '/tmp/distill-calendar-ipc-test/config.json',
  audioDir: () => '/tmp/distill-calendar-ipc-test/audio',
  userVocabularyDir: () => '/tmp/distill-calendar-ipc-test/vocabulary',
  expandHome: (value: string) => value,
}));


describe('organisation prompt IPC', () => {
  let client: Record<string, unknown>;
  const types = [
    { id: 'customer', name: 'Customer call', prompt: 'Customer', retired: 0 },
    { id: 'club-agm', name: 'AGM', prompt: 'AGM', retired: 0 },
    { id: 'club-committee', name: 'Committee meeting', prompt: 'Committee', retired: 0 },
  ];
  let state: Record<string, ReturnType<typeof vi.fn>>;
  const invoke = (channel: string, ...args: unknown[]) => mocks.handlers.get(channel)!({ sender: { id: 1 } }, ...args);
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    client = { id: 'ladffa', name: 'LADFFA', context: 'Officers', meeting_type_ids_json: '["club-agm","club-committee"]' };
    state = {
      getClient: vi.fn(id => id === 'ladffa' ? client : undefined),
      listClients: vi.fn(() => [client]),
      listMeetingTypes: vi.fn(() => types),
      getMeetingType: vi.fn(id => types.find(t => t.id === id)),
      setClientMeetingTypes: vi.fn((_id, ids) => { client.meeting_type_ids_json = ids === null ? null : JSON.stringify(ids); return true; }),
      getRecording: vi.fn(() => ({ status: 'to_file', filename: 'Minutes', duration_seconds: 60, meeting_type_id: 'customer' })),
      tagRecording: vi.fn(() => true), fileRecording: vi.fn(() => true),
    };
    registerIpcHandlers({ state, getConfig: () => ({ ollama: {} }), getWorker: () => null, logger: { info: mocks.info } } as unknown as IpcContext);
  });

  it('rejects a disallowed prompt from both tag and filing APIs', () => {
    const payload = { recordingId: 'r', clientId: 'ladffa', meetingTypeId: 'customer' };
    expect(() => invoke(Channels.TagSave, payload)).toThrow('not available for LADFFA');
    expect(() => invoke(Channels.InboxFile, payload)).toThrow('not available for LADFFA');
    expect(state.tagRecording).not.toHaveBeenCalled();
    expect(state.fileRecording).not.toHaveBeenCalled();
  });
  it('accepts an allowed prompt when tagging', () => {
    invoke(Channels.TagSave, { recordingId: 'r', clientId: 'ladffa', meetingTypeId: 'club-agm' });
    expect(state.tagRecording).toHaveBeenCalled();
  });
  it('limits automatic tag suggestions to the organisation choices', async () => {
    mocks.suggest.mockResolvedValue(null);
    await invoke(Channels.TagSuggestMeetingType, { recordingId: 'r', clientId: 'ladffa' });
    expect(mocks.suggest.mock.calls[0][1].map((t: { id: string }) => t.id)).toEqual(['club-agm', 'club-committee']);
  });
  it('saves deduplicated choices and allows an explicit return to all prompts', () => {
    expect(invoke(Channels.ClientsSetMeetingTypes, 'ladffa', ['club-agm', 'club-agm'])).toMatchObject({ meetingTypeIds: ['club-agm'], context: 'Officers' });
    expect(invoke(Channels.ClientsSetMeetingTypes, 'ladffa', null)).toMatchObject({ meetingTypeIds: null });
    expect(mocks.send).toHaveBeenCalledWith(Channels.PushInboxChanged);
  });
  it('rejects invalid choices without saving', () => {
    for (const ids of ['club-agm', [1], ['unknown']]) {
      expect(() => invoke(Channels.ClientsSetMeetingTypes, 'ladffa', ids)).toThrow();
    }
    expect(state.setClientMeetingTypes).not.toHaveBeenCalled();
  });
});
