/**
 * Every IPC channel name, in one place, shared between main, preload and
 * renderer. `push:`-prefixed channels are main → renderer broadcasts; the
 * rest are renderer → main invoke/handle pairs.
 */
export const Channels = {
  InboxList: 'inbox.list',
  InboxSkip: 'inbox.skip',
  InboxRevealInFinder: 'inbox.revealInFinder',
  InboxRevealOutput: 'inbox.revealOutput',
  InboxListHidden: 'inbox.listHidden',
  InboxUnhide: 'inbox.unhide',
  InboxSetOutputTargets: 'inbox.setOutputTargets',
  PipelineCancel: 'pipeline.cancel',
  PipelineRetry: 'pipeline.retry',
  PipelineFullRerun: 'pipeline.fullRerun',
  HistoryList: 'history.list',
  TagSave: 'tag.save',
  TagOpenSheet: 'tag.open-sheet',
  ClientsList: 'clients.list',
  ClientsAdd: 'clients.add',
  MeetingTypesList: 'meetingTypes.list',
  MeetingTypesAdd: 'meetingTypes.add',
  MeetingTypesDelete: 'meetingTypes.delete',
  LocalImportPath: 'localImport.path',
  LocalImportPickFiles: 'localImport.pickFiles',
  PushLocalImportProgress: 'push:local-import-progress',
  SettingsLoad: 'settings.load',
  SettingsSaveOutputs: 'settings.saveOutputs',
  SettingsSavePrompt: 'settings.savePrompt',
  SettingsRevertPromptToBuiltin: 'settings.revertPromptToBuiltin',
  SettingsImportPrompts: 'settings.importPrompts',
  SettingsLoadVocabulary: 'settings.loadVocabulary',
  SettingsSaveVocabulary: 'settings.saveVocabulary',
  SettingsImportVocabulary: 'settings.importVocabulary',
  SettingsExportVocabulary: 'settings.exportVocabulary',
  SettingsPreviewVocabularyBudget: 'settings.previewVocabularyBudget',
  SettingsSaveGeneral: 'settings.saveGeneral',
  SettingsSavePerformance: 'settings.savePerformance',
  SettingsListOllamaModels: 'settings.listOllamaModels',
  SettingsBrowseFolder: 'settings.browseFolder',
  SettingsInspectOutputDir: 'settings.inspectOutputDir',
  SettingsRevealPath: 'settings.revealPath',
  SettingsDismissModelSuggestion: 'settings.dismissModelSuggestion',
  SettingsPullModel: 'settings.pullModel',
  PushModelPullProgress: 'push:model-pull-progress',
  SettingsInstallParakeet: 'settings.installParakeet',
  PushParakeetInstallProgress: 'push:parakeet-install-progress',
  SourcesPlaudSignIn: 'sources.plaudSignIn',
  SourcesPlaudSignOut: 'sources.plaudSignOut',
  SourcesPlaudStatus: 'sources.plaudStatus',
  AppOpenSettings: 'app.openSettings',
  AppGetTipJarStatus: 'app.getTipJarStatus',
  AppDismissTipJarBanner: 'app.dismissTipJarBanner',
  AppOpenTipJar: 'app.openTipJar',
  SetupGetStatus: 'setup.getStatus',
  SetupStart: 'setup.start',
  SetupQuit: 'setup.quit',
  PushSetupProgress: 'push:setup-progress',
  PushInboxChanged: 'push:inbox-changed',
  PushFocusRecording: 'push:focus-recording',
} as const;

export type ChannelName = (typeof Channels)[keyof typeof Channels];

/** Ollama keep_alive presets offered in Settings → Performance. */
export const KEEPALIVE_PRESETS = [
  { value: '0', label: 'Off (unload immediately)' },
  { value: '5m', label: '5 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
] as const;

/** MLX Whisper model presets offered in Settings → Performance. */
export const WHISPER_MODEL_PRESETS = [
  { value: 'mlx-community/whisper-large-v3-mlx', label: 'Large v3 (best quality, slowest)' },
  {
    value: 'mlx-community/whisper-large-v3-turbo',
    label: 'Large v3 Turbo (near-large quality, much faster)',
  },
  { value: 'mlx-community/whisper-medium-mlx', label: 'Medium' },
  { value: 'mlx-community/whisper-small-mlx', label: 'Small' },
  { value: 'mlx-community/whisper-base-mlx', label: 'Base' },
  { value: 'mlx-community/whisper-tiny-mlx', label: 'Tiny (fastest, lowest quality)' },
] as const;
