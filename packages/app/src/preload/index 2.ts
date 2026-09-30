/**
 * Preload script.
 *
 * Runs in a privileged context with access to Node APIs and ipcRenderer,
 * exposes a typed `window.distill` API to the renderer via contextBridge.
 *
 * All renderer ↔ main communication flows through the methods below. The
 * renderer never touches ipcRenderer directly — contextIsolation is on,
 * so it couldn't anyway.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  Channels,
  type AddClientPayload,
  type AddMeetingTypePayload,
  type ClientDTO,
  type InboxRecordingDTO,
  type MeetingTypeDTO,
  type OllamaModelsResult,
  type OutputsDTO,
  type DistillApi,
  type LocalImportProgressEvent,
  type PlaudAccountStatus,
  type PlaudSignInPayload,
  type SettingsTab,
  type TipJarStatusDTO,
  type SaveGeneralPayload,
  type SavePerformancePayload,
  type SavePromptPayload,
  type SaveVocabularyPayload,
  type SettingsDTO,
  type SetupInitialStatus,
  type SetupPhase,
  type SetupProgressEvent,
  type TagSavePayload,
  type VocabularyFileDTO,
  type VocabularyScopeSummaryDTO,
} from '../shared/ipc-contract.js';

const api: DistillApi = {
  inbox: {
    list: (): Promise<InboxRecordingDTO[]> => ipcRenderer.invoke(Channels.InboxList),
    skip: (recordingId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.InboxSkip, recordingId),
    revealInFinder: (recordingId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.InboxRevealInFinder, recordingId),
  },

  pipeline: {
    cancel: (recordingId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.PipelineCancel, recordingId),
    retry: (recordingId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.PipelineRetry, recordingId),
  },

  tag: {
    open: (recordingId: string): Promise<void> =>
      ipcRenderer.invoke(Channels.TagOpenSheet, recordingId),
    save: (payload: TagSavePayload): Promise<void> =>
      ipcRenderer.invoke(Channels.TagSave, payload),
    getSheetRecordingId: (): string | null => {
      const arg = process.argv.find((a) => a.startsWith('--recording-id='));
      return arg ? arg.slice('--recording-id='.length) : null;
    },
  },

  clients: {
    list: (): Promise<ClientDTO[]> => ipcRenderer.invoke(Channels.ClientsList),
    add: (payload: AddClientPayload): Promise<ClientDTO> =>
      ipcRenderer.invoke(Channels.ClientsAdd, payload),
  },

  meetingTypes: {
    list: (): Promise<MeetingTypeDTO[]> => ipcRenderer.invoke(Channels.MeetingTypesList),
    add: (payload: AddMeetingTypePayload): Promise<MeetingTypeDTO> =>
      ipcRenderer.invoke(Channels.MeetingTypesAdd, payload),
    delete: (id: string): Promise<{ deletedId: string }> =>
      ipcRenderer.invoke(Channels.MeetingTypesDelete, id),
  },

  localImport: {
    importPath: (path: string): Promise<{ recordingId: string }> =>
      ipcRenderer.invoke(Channels.LocalImportPath, path),
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke(Channels.LocalImportPickFiles),
    getPathForFile: (file: File): string => {
      // Electron 32+ provides webUtils.getPathForFile. Older runtimes
      // expose a non-standard File.path. Fall back gracefully.
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return (file as unknown as { path?: string }).path ?? '';
      }
    },
  },

  settings: {
    load: (): Promise<SettingsDTO> => ipcRenderer.invoke(Channels.SettingsLoad),
    saveOutputs: (payload: OutputsDTO): Promise<void> =>
      ipcRenderer.invoke(Channels.SettingsSaveOutputs, payload),
    savePrompt: (payload: SavePromptPayload): Promise<MeetingTypeDTO> =>
      ipcRenderer.invoke(Channels.SettingsSavePrompt, payload),
    revertPromptToBuiltin: (id: string): Promise<MeetingTypeDTO> =>
      ipcRenderer.invoke(Channels.SettingsRevertPromptToBuiltin, id),
    importPrompts: (): Promise<
      | { created: number; updated: number; prompts: MeetingTypeDTO[] }
      | null
    > => ipcRenderer.invoke(Channels.SettingsImportPrompts),
    loadVocabulary: (scopeId: string): Promise<VocabularyFileDTO> =>
      ipcRenderer.invoke(Channels.SettingsLoadVocabulary, scopeId),
    saveVocabulary: (
      payload: SaveVocabularyPayload,
    ): Promise<VocabularyScopeSummaryDTO> =>
      ipcRenderer.invoke(Channels.SettingsSaveVocabulary, payload),
    importVocabulary: (scopeId: string): Promise<VocabularyFileDTO | null> =>
      ipcRenderer.invoke(Channels.SettingsImportVocabulary, scopeId),
    exportVocabulary: (scopeId: string): Promise<{ path: string } | null> =>
      ipcRenderer.invoke(Channels.SettingsExportVocabulary, scopeId),
    saveGeneral: (payload: SaveGeneralPayload): Promise<void> =>
      ipcRenderer.invoke(Channels.SettingsSaveGeneral, payload),
    savePerformance: (payload: SavePerformancePayload): Promise<void> =>
      ipcRenderer.invoke(Channels.SettingsSavePerformance, payload),
    listOllamaModels: (): Promise<OllamaModelsResult> =>
      ipcRenderer.invoke(Channels.SettingsListOllamaModels),
    browseFolder: (currentPath: string | null): Promise<string | null> =>
      ipcRenderer.invoke(Channels.SettingsBrowseFolder, currentPath),
  },

  sources: {
    signInPlaud: (payload: PlaudSignInPayload): Promise<PlaudAccountStatus> =>
      ipcRenderer.invoke(Channels.SourcesPlaudSignIn, payload),
    signOutPlaud: (): Promise<void> =>
      ipcRenderer.invoke(Channels.SourcesPlaudSignOut),
    getPlaudStatus: (): Promise<PlaudAccountStatus> =>
      ipcRenderer.invoke(Channels.SourcesPlaudStatus),
  },

  app: {
    openSettings: (opts?: { tab?: SettingsTab }): Promise<void> =>
      ipcRenderer.invoke(Channels.AppOpenSettings, opts),
    getTipJarStatus: (): Promise<TipJarStatusDTO> =>
      ipcRenderer.invoke(Channels.AppGetTipJarStatus),
    dismissTipJarBanner: (): Promise<void> =>
      ipcRenderer.invoke(Channels.AppDismissTipJarBanner),
    openTipJar: (): Promise<void> =>
      ipcRenderer.invoke(Channels.AppOpenTipJar),
  },

  setup: {
    getStatus: (): Promise<SetupInitialStatus> =>
      ipcRenderer.invoke(Channels.SetupGetStatus),
    start: (): Promise<
      | { kind: 'success' }
      | { kind: 'failed'; phase: SetupPhase; message: string }
      | { kind: 'cancelled' }
    > => ipcRenderer.invoke(Channels.SetupStart),
    quit: (): Promise<void> => ipcRenderer.invoke(Channels.SetupQuit),
  },

  onInboxChanged: (handler: () => void): (() => void) => {
    const wrapped = (): void => handler();
    ipcRenderer.on(Channels.PushInboxChanged, wrapped);
    return () => ipcRenderer.off(Channels.PushInboxChanged, wrapped);
  },

  onFocusRecording: (handler: (recordingId: string) => void): (() => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, id: string): void => handler(id);
    ipcRenderer.on(Channels.PushFocusRecording, wrapped);
    return () => ipcRenderer.off(Channels.PushFocusRecording, wrapped);
  },

  onLocalImportProgress: (
    handler: (p: LocalImportProgressEvent) => void,
  ): (() => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, p: LocalImportProgressEvent): void =>
      handler(p);
    ipcRenderer.on(Channels.PushLocalImportProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushLocalImportProgress, wrapped);
  },

  onSetupProgress: (
    handler: (e: SetupProgressEvent) => void,
  ): (() => void) => {
    const wrapped = (_evt: Electron.IpcRendererEvent, e: SetupProgressEvent): void =>
      handler(e);
    ipcRenderer.on(Channels.PushSetupProgress, wrapped);
    return () => ipcRenderer.off(Channels.PushSetupProgress, wrapped);
  },
};

contextBridge.exposeInMainWorld('distill', api);
