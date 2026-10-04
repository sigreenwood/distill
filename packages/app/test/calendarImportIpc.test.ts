import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '../src/shared/ipcChannels.js';
import { registerIpcHandlers, type IpcContext } from '../src/main/ipc.js';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  showOpenDialog: vi.fn(),
  importCalendarPdfs: vi.fn(),
  send: vi.fn(),
  info: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => '/app' },
  clipboard: {},
  shell: {},
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
}));
vi.mock('../src/main/calendar/service.js', () => ({ importCalendarPdfs: mocks.importCalendarPdfs }));
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

describe('calendar import IPC', () => {
  const state = {};
  const result = { files: [{ name: 'Calendar.pdf', meetings: 2, warnings: [] }], meetings: 2, matched: 1, accountsSuggested: 1 };
  const invoke = (paths?: unknown) => Promise.resolve(mocks.handlers.get(Channels.CalendarImportPdfs)!({}, paths));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.importCalendarPdfs.mockResolvedValue(result);
    registerIpcHandlers({ state, logger: { info: mocks.info } } as unknown as IpcContext);
  });

  it('imports dropped PDFs without a picker and broadcasts the imported result', async () => {
    await expect(invoke(['/tmp/Calendar.PDF', '/tmp/./Calendar.PDF'])).resolves.toEqual(result);
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(mocks.importCalendarPdfs).toHaveBeenCalledWith(state, ['/tmp/Calendar.PDF'], {
      binary: '/app/venv/bin/python', script: '/app/python/calendar_pdf.py',
    });
    expect(mocks.info).toHaveBeenCalledWith(expect.objectContaining({ files: 1, meetings: 2, matched: 1, accounts: 1 }), 'calendar printouts imported');
    expect(mocks.send).toHaveBeenCalledWith(Channels.PushInboxChanged);
  });

  it('retains the file picker when paths are omitted', async () => {
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/Calendar.pdf'] });
    await expect(invoke()).resolves.toEqual(result);
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }));
    expect(mocks.importCalendarPdfs).toHaveBeenCalledWith(state, ['/tmp/Calendar.pdf'], expect.anything());
  });

  it.each([{ canceled: true, filePaths: [] }, { canceled: false, filePaths: [] }])(
    'returns null without importing when the picker yields no selection', async (picked) => {
      mocks.showOpenDialog.mockResolvedValue(picked);
      await expect(invoke()).resolves.toBeNull();
      expect(mocks.importCalendarPdfs).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each([[], null, 'Calendar.pdf', ['/tmp/Calendar.pdf', '/tmp/audio.m4a']])(
    'rejects invalid supplied paths without opening a picker or importing', async (paths) => {
      await expect(invoke(paths)).rejects.toThrow();
      expect(mocks.showOpenDialog).not.toHaveBeenCalled();
      expect(mocks.importCalendarPdfs).not.toHaveBeenCalled();
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it('surfaces import failures without broadcasting a successful change', async () => {
    mocks.importCalendarPdfs.mockRejectedValue(new Error('Unable to read PDF'));
    await expect(invoke(['/tmp/Calendar.pdf'])).rejects.toThrow('Unable to read PDF');
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
