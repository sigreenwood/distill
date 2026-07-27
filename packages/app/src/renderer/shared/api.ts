/**
 * Renderer-side view of the preload bridge (`window.distill`) and the
 * DTOs main sends over it. Kept in the renderer tree (not imported from
 * main) so tsconfig.web stays independent of Node types; shapes must
 * match main/ipc.ts DTO mappers.
 */

export type RecordingStatus =
  | 'inbox'
  | 'tagged'
  | 'downloading'
  | 'transcribing'
  | 'summarising'
  | 'writing'
  | 'complete'
  | 'error'
  | 'cancelled'
  | 'skipped';

export type PipelineStep = 'download' | 'transcribe' | 'summarise' | 'write';

export interface InboxItemDTO {
  id: string;
  filename: string;
  duration_seconds: number | null;
  start_time: number | null;
  synced_at: number;
  status: RecordingStatus;
  currentStep: PipelineStep | null;
  clientName: string | null;
  meetingTypeName: string | null;
  error: string | null;
  isAuthError: boolean;
  markdownPath: string | null;
  vocabularySources: string | null;
  vocabularyRulesApplied: number | null;
  truncationWarning: boolean;
  estimatedInputTokens: number | null;
  contextWindowAtSubmit: number | null;
  modelSnapshot: string | null;
  processedExternally: boolean;
}

export interface ClientDTO {
  id: string;
  name: string;
  is_builtin: boolean;
  sort_order: number;
}

export interface MeetingTypeDTO {
  id: string;
  name: string;
  prompt: string;
  is_builtin: boolean;
  sort_order: number;
  updated_at: number;
  is_modified: boolean;
}

export interface OutputDestinationDTO {
  enabled: boolean;
  dir: string;
  includeTranscript: boolean;
}

export interface AppleNotesDestinationDTO {
  enabled: boolean;
  parentFolder: string;
  includeTranscript: boolean;
}

export interface OutputsDTO {
  markdown: OutputDestinationDTO;
  html: OutputDestinationDTO;
  appleNotes: AppleNotesDestinationDTO;
}

export interface VocabularyScopeDTO {
  id: string;
  label: string;
  builtin: boolean;
  termCount: number;
}

export interface VocabularyReplacementDTO {
  from: string;
  to: string;
  requiresContext?: string[];
}

export interface VocabularyFileDTO {
  whisperHints: string[];
  replacements: VocabularyReplacementDTO[];
  notes?: string[];
}

export interface GeneralDTO {
  audioRetentionDays: number | null;
}

export interface PerformanceDTO {
  ollamaModel: string;
  ollamaKeepAlive: string;
  whisperModel: string;
}

export type PlaudStatusDTO =
  | { signedIn: false }
  | { signedIn: true; email: string; region: string; tokenExpiresAt: number | null };

export interface SourcesDTO {
  plaud: PlaudStatusDTO;
}

export interface SystemInfoDTO {
  totalRamGb: number;
  recommendedModel: string;
  recommendedReason: string;
  recommendationTable: { ram: string; model: string }[];
}

export interface ModelSuggestionDTO {
  newFamily: string;
  suggestedModel: string;
  currentModel: string;
  checkedAt: number;
}

export interface ModelPullProgressDTO {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  percent: number | null;
}

export interface SettingsDTO {
  outputs: OutputsDTO;
  prompts: MeetingTypeDTO[];
  vocabularyScopes: VocabularyScopeDTO[];
  general: GeneralDTO;
  performance: PerformanceDTO;
  sources: SourcesDTO;
  system: SystemInfoDTO;
  modelSuggestion: ModelSuggestionDTO | null;
}

export type OllamaModelsDTO =
  | { ok: true; models: { name: string; sizeBytes?: number }[] }
  | { ok: false; reason: 'unreachable'; detail: string };

export interface TipJarStatusDTO {
  completionCount: number;
  bannerDismissed: boolean;
  thresholdNotified: boolean;
  shouldShowBanner: boolean;
  url: string;
  threshold: number;
}

export interface LocalImportProgressDTO {
  sourcePath: string;
  phase: 'probe' | 'copy' | 'extract' | 'finalise';
  percent: number | null;
}

export type SetupPhase = 'creating-venv' | 'installing-packages' | 'verifying';

export type SetupStatusDTO =
  | { kind: 'python-missing'; triedPaths: string[] }
  | { kind: 'needs-setup'; systemPython: string; systemPythonVersion: string; reason: string };

export type SetupStartResultDTO =
  | { kind: 'success' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; phase: SetupPhase; message: string };

export interface SetupProgressDTO {
  kind: 'phase' | 'log' | 'done' | 'failed';
  phase?: SetupPhase;
  log?: { stream: 'stdout' | 'stderr'; text: string };
  failure?: { phase: SetupPhase; message: string };
}

export interface DistillApi {
  inbox: {
    list(): Promise<InboxItemDTO[]>;
    skip(recordingId: string): Promise<void>;
    revealInFinder(recordingId: string): Promise<void>;
  };
  pipeline: {
    cancel(recordingId: string): Promise<void>;
    retry(recordingId: string): Promise<void>;
  };
  tag: {
    open(recordingId: string): Promise<void>;
    save(payload: { recordingId: string; clientId: string; meetingTypeId: string }): Promise<void>;
    getSheetRecordingId(): string | null;
  };
  clients: {
    list(): Promise<ClientDTO[]>;
    add(payload: { name: string }): Promise<ClientDTO>;
  };
  meetingTypes: {
    list(): Promise<MeetingTypeDTO[]>;
    add(payload: { name: string; prompt: string }): Promise<MeetingTypeDTO>;
    delete(id: string): Promise<{ deletedId: string }>;
  };
  localImport: {
    importPath(path: string): Promise<{ recordingId: string }>;
    pickFiles(): Promise<string[]>;
    getPathForFile(file: File): string;
  };
  settings: {
    load(): Promise<SettingsDTO>;
    saveOutputs(payload: OutputsDTO): Promise<void>;
    savePrompt(payload: { id: string; prompt: string; name?: string }): Promise<MeetingTypeDTO>;
    revertPromptToBuiltin(id: string): Promise<MeetingTypeDTO>;
    importPrompts(): Promise<{ created: number; updated: number; prompts: MeetingTypeDTO[] } | null>;
    loadVocabulary(scopeId: string): Promise<VocabularyFileDTO>;
    saveVocabulary(payload: { scopeId: string; file: VocabularyFileDTO }): Promise<VocabularyScopeDTO>;
    importVocabulary(scopeId: string): Promise<VocabularyFileDTO | null>;
    exportVocabulary(scopeId: string): Promise<{ path: string } | null>;
    saveGeneral(payload: GeneralDTO): Promise<void>;
    savePerformance(payload: PerformanceDTO): Promise<void>;
    listOllamaModels(): Promise<OllamaModelsDTO>;
    browseFolder(currentPath?: string): Promise<string | null>;
    dismissModelSuggestion(): Promise<void>;
    pullModel(model: string): Promise<{ ok: true } | { ok: false; error: string }>;
  };
  sources: {
    signInPlaud(payload: { email: string; password: string; region: string }): Promise<PlaudStatusDTO>;
    signOutPlaud(): Promise<void>;
    getPlaudStatus(): Promise<PlaudStatusDTO>;
  };
  app: {
    openSettings(opts?: { tab?: string }): Promise<void>;
    getTipJarStatus(): Promise<TipJarStatusDTO>;
    dismissTipJarBanner(): Promise<void>;
    openTipJar(): Promise<void>;
  };
  setup: {
    getStatus(): Promise<SetupStatusDTO>;
    start(): Promise<SetupStartResultDTO>;
    quit(): Promise<void>;
  };
  onInboxChanged(handler: () => void): () => void;
  onFocusRecording(handler: (id: string) => void): () => void;
  onLocalImportProgress(handler: (p: LocalImportProgressDTO) => void): () => void;
  onSetupProgress(handler: (e: SetupProgressDTO) => void): () => void;
  onModelPullProgress(handler: (p: ModelPullProgressDTO) => void): () => void;
}

declare global {
  interface Window {
    distill: DistillApi;
  }
  /** Injected at build time by electron.vite.config.ts (Vite define). */
  const __APP_VERSION__: string;
}
