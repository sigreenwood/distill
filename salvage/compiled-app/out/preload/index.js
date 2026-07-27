"use strict";
const electron = require("electron");
const Channels = {
  InboxList: "inbox.list",
  InboxSkip: "inbox.skip",
  InboxRevealInFinder: "inbox.revealInFinder",
  PipelineCancel: "pipeline.cancel",
  PipelineRetry: "pipeline.retry",
  TagSave: "tag.save",
  TagOpenSheet: "tag.open-sheet",
  ClientsList: "clients.list",
  ClientsAdd: "clients.add",
  MeetingTypesList: "meetingTypes.list",
  MeetingTypesAdd: "meetingTypes.add",
  MeetingTypesDelete: "meetingTypes.delete",
  LocalImportPath: "localImport.path",
  LocalImportPickFiles: "localImport.pickFiles",
  PushLocalImportProgress: "push:local-import-progress",
  SettingsLoad: "settings.load",
  SettingsSaveOutputs: "settings.saveOutputs",
  SettingsSavePrompt: "settings.savePrompt",
  SettingsRevertPromptToBuiltin: "settings.revertPromptToBuiltin",
  SettingsImportPrompts: "settings.importPrompts",
  SettingsLoadVocabulary: "settings.loadVocabulary",
  SettingsSaveVocabulary: "settings.saveVocabulary",
  SettingsImportVocabulary: "settings.importVocabulary",
  SettingsExportVocabulary: "settings.exportVocabulary",
  SettingsSaveGeneral: "settings.saveGeneral",
  SettingsSavePerformance: "settings.savePerformance",
  SettingsListOllamaModels: "settings.listOllamaModels",
  SettingsBrowseFolder: "settings.browseFolder",
  SourcesPlaudSignIn: "sources.plaudSignIn",
  SourcesPlaudSignOut: "sources.plaudSignOut",
  SourcesPlaudStatus: "sources.plaudStatus",
  AppOpenSettings: "app.openSettings",
  AppGetTipJarStatus: "app.getTipJarStatus",
  AppDismissTipJarBanner: "app.dismissTipJarBanner",
  AppOpenTipJar: "app.openTipJar",
  SetupGetStatus: "setup.getStatus",
  SetupStart: "setup.start",
  SetupQuit: "setup.quit",
  PushSetupProgress: "push:setup-progress",
  PushInboxChanged: "push:inbox-changed",
  PushFocusRecording: "push:focus-recording"
};
const api = {
  inbox: {
    list: () => electron.ipcRenderer.invoke(Channels.InboxList),
    skip: (recordingId) => electron.ipcRenderer.invoke(Channels.InboxSkip, recordingId),
    revealInFinder: (recordingId) => electron.ipcRenderer.invoke(Channels.InboxRevealInFinder, recordingId)
  },
  pipeline: {
    cancel: (recordingId) => electron.ipcRenderer.invoke(Channels.PipelineCancel, recordingId),
    retry: (recordingId) => electron.ipcRenderer.invoke(Channels.PipelineRetry, recordingId)
  },
  tag: {
    open: (recordingId) => electron.ipcRenderer.invoke(Channels.TagOpenSheet, recordingId),
    save: (payload) => electron.ipcRenderer.invoke(Channels.TagSave, payload),
    getSheetRecordingId: () => {
      const arg = process.argv.find((a) => a.startsWith("--recording-id="));
      return arg ? arg.slice("--recording-id=".length) : null;
    }
  },
  clients: {
    list: () => electron.ipcRenderer.invoke(Channels.ClientsList),
    add: (payload) => electron.ipcRenderer.invoke(Channels.ClientsAdd, payload)
  },
  meetingTypes: {
    list: () => electron.ipcRenderer.invoke(Channels.MeetingTypesList),
    add: (payload) => electron.ipcRenderer.invoke(Channels.MeetingTypesAdd, payload),
    delete: (id) => electron.ipcRenderer.invoke(Channels.MeetingTypesDelete, id)
  },
  localImport: {
    importPath: (path) => electron.ipcRenderer.invoke(Channels.LocalImportPath, path),
    pickFiles: () => electron.ipcRenderer.invoke(Channels.LocalImportPickFiles),
    getPathForFile: (file) => {
      try {
        return electron.webUtils.getPathForFile(file);
      } catch {
        return file.path ?? "";
      }
    }
  },
  settings: {
    load: () => electron.ipcRenderer.invoke(Channels.SettingsLoad),
    saveOutputs: (payload) => electron.ipcRenderer.invoke(Channels.SettingsSaveOutputs, payload),
    savePrompt: (payload) => electron.ipcRenderer.invoke(Channels.SettingsSavePrompt, payload),
    revertPromptToBuiltin: (id) => electron.ipcRenderer.invoke(Channels.SettingsRevertPromptToBuiltin, id),
    importPrompts: () => electron.ipcRenderer.invoke(Channels.SettingsImportPrompts),
    loadVocabulary: (scopeId) => electron.ipcRenderer.invoke(Channels.SettingsLoadVocabulary, scopeId),
    saveVocabulary: (payload) => electron.ipcRenderer.invoke(Channels.SettingsSaveVocabulary, payload),
    importVocabulary: (scopeId) => electron.ipcRenderer.invoke(Channels.SettingsImportVocabulary, scopeId),
    exportVocabulary: (scopeId) => electron.ipcRenderer.invoke(Channels.SettingsExportVocabulary, scopeId),
    saveGeneral: (payload) => electron.ipcRenderer.invoke(Channels.SettingsSaveGeneral, payload),
    savePerformance: (payload) => electron.ipcRenderer.invoke(Channels.SettingsSavePerformance, payload),
    listOllamaModels: () => electron.ipcRenderer.invoke(Channels.SettingsListOllamaModels),
    browseFolder: (currentPath) => electron.ipcRenderer.invoke(Channels.SettingsBrowseFolder, currentPath)
  },
  sources: {
    signInPlaud: (payload) => electron.ipcRenderer.invoke(Channels.SourcesPlaudSignIn, payload),
    signOutPlaud: () => electron.ipcRenderer.invoke(Channels.SourcesPlaudSignOut),
    getPlaudStatus: () => electron.ipcRenderer.invoke(Channels.SourcesPlaudStatus)
  },
  app: {
    openSettings: (opts) => electron.ipcRenderer.invoke(Channels.AppOpenSettings, opts),
    getTipJarStatus: () => electron.ipcRenderer.invoke(Channels.AppGetTipJarStatus),
    dismissTipJarBanner: () => electron.ipcRenderer.invoke(Channels.AppDismissTipJarBanner),
    openTipJar: () => electron.ipcRenderer.invoke(Channels.AppOpenTipJar)
  },
  setup: {
    getStatus: () => electron.ipcRenderer.invoke(Channels.SetupGetStatus),
    start: () => electron.ipcRenderer.invoke(Channels.SetupStart),
    quit: () => electron.ipcRenderer.invoke(Channels.SetupQuit)
  },
  onInboxChanged: (handler) => {
    const wrapped = () => handler();
    electron.ipcRenderer.on(Channels.PushInboxChanged, wrapped);
    return () => electron.ipcRenderer.off(Channels.PushInboxChanged, wrapped);
  },
  onFocusRecording: (handler) => {
    const wrapped = (_evt, id) => handler(id);
    electron.ipcRenderer.on(Channels.PushFocusRecording, wrapped);
    return () => electron.ipcRenderer.off(Channels.PushFocusRecording, wrapped);
  },
  onLocalImportProgress: (handler) => {
    const wrapped = (_evt, p) => handler(p);
    electron.ipcRenderer.on(Channels.PushLocalImportProgress, wrapped);
    return () => electron.ipcRenderer.off(Channels.PushLocalImportProgress, wrapped);
  },
  onSetupProgress: (handler) => {
    const wrapped = (_evt, e) => handler(e);
    electron.ipcRenderer.on(Channels.PushSetupProgress, wrapped);
    return () => electron.ipcRenderer.off(Channels.PushSetupProgress, wrapped);
  }
};
electron.contextBridge.exposeInMainWorld("distill", api);
