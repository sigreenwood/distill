import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { Channels } from '../shared/ipcChannels.js';
import type { Attendee } from '../shared/attendees.js';

/**
 * The renderer-facing API, exposed as `window.distill`. Every call maps
 * 1:1 onto an IPC channel; the preload adds no logic beyond argument
 * plumbing so the contract lives entirely in main/ipc.ts.
 */
const api = {
  meeting: {
    open: (recordingId: string, scope: 'summary' | 'transcript' = 'summary') =>
      ipcRenderer.invoke(Channels.MeetingOpen, recordingId, scope),
    get: (recordingId: string) => ipcRenderer.invoke(Channels.MeetingGet, recordingId),
    correct: (payload: {
      recordingId: string;
      from: string;
      to: string;
      rememberScope?: 'client' | 'organisation' | 'global' | null;
    }) => ipcRenderer.invoke(Channels.MeetingCorrect, payload),
  },
  brief: {
    listMeetings: (clientId: string, sinceDays: number | null) =>
      ipcRenderer.invoke(Channels.BriefListMeetings, clientId, sinceDays),
    generate: (payload: { clientId: string; recordingIds: string[] }) =>
      ipcRenderer.invoke(Channels.BriefGenerate, payload),
    cancel: () => ipcRenderer.invoke(Channels.BriefCancel),
  },
  register: {
    list: (clientId?: string) => ipcRenderer.invoke(Channels.RegisterList, clientId),
    add: (payload: {
      clientId: string;
      kind: 'action' | 'decision';
      text: string;
      owner?: string | null;
      dueAt?: number | null;
      sourceRecordingId: string;
    }) => ipcRenderer.invoke(Channels.RegisterAdd, payload),
    setStatus: (id: string, status: 'open' | 'done') =>
      ipcRenderer.invoke(Channels.RegisterSetStatus, id, status),
    delete: (id: string) => ipcRenderer.invoke(Channels.RegisterDelete, id),
  },
  summaryVersions: {
    list: (recordingId: string) => ipcRenderer.invoke(Channels.SummaryVersionsList, recordingId),
    generate: (payload: { recordingId: string; model?: string; meetingTypeId?: string }) =>
      ipcRenderer.invoke(Channels.SummaryVersionsGenerate, payload),
    cancel: () => ipcRenderer.invoke(Channels.SummaryVersionsCancel),
    activate: (id: string) => ipcRenderer.invoke(Channels.SummaryVersionsActivate, id),
  },
  inbox: {
    search: (query: string, scope: 'summary' | 'transcript') => ipcRenderer.invoke(Channels.InboxSearch, query, scope),
    list: () => ipcRenderer.invoke(Channels.InboxList),
    skip: (recordingId: string) => ipcRenderer.invoke(Channels.InboxSkip, recordingId),
    revealInFinder: (recordingId: string) =>
      ipcRenderer.invoke(Channels.InboxRevealInFinder, recordingId),
    revealOutput: (recordingId: string, kind: 'markdown' | 'html' | 'appleNote') =>
      ipcRenderer.invoke(Channels.InboxRevealOutput, recordingId, kind),
    listHidden: () => ipcRenderer.invoke(Channels.InboxListHidden),
    unhide: (recordingId: string) => ipcRenderer.invoke(Channels.InboxUnhide, recordingId),
    setOutputTargets: (
      recordingId: string,
      targets: { markdown: boolean; html: boolean; appleNote: boolean },
    ) => ipcRenderer.invoke(Channels.InboxSetOutputTargets, recordingId, targets),
  },
  pipeline: {
    cancel: (recordingId: string) => ipcRenderer.invoke(Channels.PipelineCancel, recordingId),
    retry: (recordingId: string) => ipcRenderer.invoke(Channels.PipelineRetry, recordingId),
    fullRerun: (recordingId: string) => ipcRenderer.invoke(Channels.PipelineFullRerun, recordingId),
  },
  history: {
    list: (payload: { search?: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke(Channels.HistoryList, payload),
  },
  tag: {
    open: (recordingId: string) => ipcRenderer.invoke(Channels.TagOpenSheet, recordingId),
    save: (payload: {
      recordingId: string;
      clientId: string;
      meetingTypeId: string;
      attendees?: Attendee[];
    }) => ipcRenderer.invoke(Channels.TagSave, payload),
    frequentAttendees: (clientId: string) =>
      ipcRenderer.invoke(Channels.TagFrequentAttendees, clientId),
    suggestClient: (attendees: Attendee[]) =>
      ipcRenderer.invoke(Channels.TagSuggestClient, attendees),
    clipboardAttendees: () => ipcRenderer.invoke(Channels.TagClipboardAttendees),
    getSheetRecordingId: (): string | null => {
      const arg = process.argv.find((a) => a.startsWith('--recording-id='));
      return arg ? arg.slice('--recording-id='.length) : null;
    },
  },
  clients: {
    list: () => ipcRenderer.invoke(Channels.ClientsList),
    add: (payload: { name: string }) => ipcRenderer.invoke(Channels.ClientsAdd, payload),
  },
  meetingTypes: {
    list: () => ipcRenderer.invoke(Channels.MeetingTypesList),
    add: (payload: { name: string; prompt: string }) =>
      ipcRenderer.invoke(Channels.MeetingTypesAdd, payload),
    delete: (id: string) => ipcRenderer.invoke(Channels.MeetingTypesDelete, id),
  },
  localImport: {
    importPath: (path: string) => ipcRenderer.invoke(Channels.LocalImportPath, path),
    pickFiles: () => ipcRenderer.invoke(Channels.LocalImportPickFiles),
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return (file as File & { path?: string }).path ?? '';
      }
    },
  },
  settings: {
    load: () => ipcRenderer.invoke(Channels.SettingsLoad),
    saveOutputs: (payload: unknown) => ipcRenderer.invoke(Channels.SettingsSaveOutputs, payload),
    savePrompt: (payload: { id: string; prompt: string; name?: string }) =>
      ipcRenderer.invoke(Channels.SettingsSavePrompt, payload),
    revertPromptToBuiltin: (id: string) =>
      ipcRenderer.invoke(Channels.SettingsRevertPromptToBuiltin, id),
    importPrompts: () => ipcRenderer.invoke(Channels.SettingsImportPrompts),
    loadVocabulary: (scopeId: string) =>
      ipcRenderer.invoke(Channels.SettingsLoadVocabulary, scopeId),
    saveVocabulary: (payload: unknown) =>
      ipcRenderer.invoke(Channels.SettingsSaveVocabulary, payload),
    importVocabulary: (scopeId: string) =>
      ipcRenderer.invoke(Channels.SettingsImportVocabulary, scopeId),
    exportVocabulary: (scopeId: string) =>
      ipcRenderer.invoke(Channels.SettingsExportVocabulary, scopeId),
    previewVocabularyBudget: (payload: unknown) =>
      ipcRenderer.invoke(Channels.SettingsPreviewVocabularyBudget, payload),
    saveGeneral: (payload: unknown) => ipcRenderer.invoke(Channels.SettingsSaveGeneral, payload),
    savePerformance: (payload: unknown) =>
      ipcRenderer.invoke(Channels.SettingsSavePerformance, payload),
    listOllamaModels: () => ipcRenderer.invoke(Channels.SettingsListOllamaModels),
    browseFolder: (currentPath?: string) =>
      ipcRenderer.invoke(Channels.SettingsBrowseFolder, currentPath),
    inspectOutputDir: (dir: string) => ipcRenderer.invoke(Channels.SettingsInspectOutputDir, dir),
    revealPath: (dir: string) => ipcRenderer.invoke(Channels.SettingsRevealPath, dir),
    dismissModelSuggestion: () => ipcRenderer.invoke(Channels.SettingsDismissModelSuggestion),
    pullModel: (model: string) => ipcRenderer.invoke(Channels.SettingsPullModel, model),
    installParakeet: () => ipcRenderer.invoke(Channels.SettingsInstallParakeet),
  },
  sources: {
    signInPlaud: (payload: { email: string; password: string; region: string }) =>
      ipcRenderer.invoke(Channels.SourcesPlaudSignIn, payload),
    signOutPlaud: () => ipcRenderer.invoke(Channels.SourcesPlaudSignOut),
    getPlaudStatus: () => ipcRenderer.invoke(Channels.SourcesPlaudStatus),
  },
  app: {
    openSettings: (opts?: { tab?: string }) => ipcRenderer.invoke(Channels.AppOpenSettings, opts),
    getTipJarStatus: () => ipcRenderer.invoke(Channels.AppGetTipJarStatus),
    dismissTipJarBanner: () => ipcRenderer.invoke(Channels.AppDismissTipJarBanner),
    openTipJar: () => ipcRenderer.invoke(Channels.AppOpenTipJar),
  },
  setup: {
    getStatus: () => ipcRenderer.invoke(Channels.SetupGetStatus),
    start: () => ipcRenderer.invoke(Channels.SetupStart),
    quit: () => ipcRenderer.invoke(Channels.SetupQuit),
  },
  onInboxChanged: (handler: () => void) => {
    const wrapped = () => handler();
    ipcRenderer.on(Channels.PushInboxChanged, wrapped);
    return () => ipcRenderer.off(Channels.PushInboxChanged, wrapped);
  },
  onFocusRecording: (handler: (id: string) => void) => {
    const wrapped = (_evt: IpcRendererEvent, id: string) => handler(id);
    ipcRenderer.on(Channels.PushFocusRecording, wrapped);
    return () => ipcRenderer.off(Channels.PushFocusRecording, wrapped);
  },
  onLocalImportProgress: (handler: (p: unknown) => void) => {
    const wrapped = (_evt: IpcRendererEvent, p: unknown) => handler(p);
    ipcRenderer.on(Channels.PushLocalImportProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushLocalImportProgress, wrapped);
  },
  onSetupProgress: (handler: (e: unknown) => void) => {
    const wrapped = (_evt: IpcRendererEvent, e: unknown) => handler(e);
    ipcRenderer.on(Channels.PushSetupProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushSetupProgress, wrapped);
  },
  onParakeetInstallProgress: (handler: (p: unknown) => void) => {
    const wrapped = (_evt: IpcRendererEvent, p: unknown) => handler(p);
    ipcRenderer.on(Channels.PushParakeetInstallProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushParakeetInstallProgress, wrapped);
  },
  onModelPullProgress: (handler: (p: unknown) => void) => {
    const wrapped = (_evt: IpcRendererEvent, p: unknown) => handler(p);
    ipcRenderer.on(Channels.PushModelPullProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushModelPullProgress, wrapped);
  },
};

export type DistillApi = typeof api;

contextBridge.exposeInMainWorld('distill', api);
