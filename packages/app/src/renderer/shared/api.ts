import type { MeetingSearchResponse, SearchScope } from '../../shared/search.js';
import type { MeetingDetail } from '../../shared/meeting.js';
/**
 * Renderer-side view of the preload bridge (`window.distill`) and the
 * DTOs main sends over it. Kept in the renderer tree (not imported from
 * main) so tsconfig.web stays independent of Node types; shapes must
 * match main/ipc.ts DTO mappers.
 */

import type { Attendee, FrequentAttendee } from '../../shared/attendees.js';
export type { Attendee, FrequentAttendee };

export type RecordingStatus =
  | 'inbox'
  | 'tagged'
  | 'downloading'
  | 'transcribing'
  | 'summarising'
  | 'writing'
  | 'to_file'
  | 'complete'
  | 'error'
  | 'cancelled'
  | 'skipped';

import type { BriefCandidate, ClientBrief } from '../../shared/brief';
import type { RegisterItem } from '../../shared/register';
import type { SummaryVersionDTO } from '../../shared/summaryVersion';
import type { MeetingTypeSuggestion } from '../../shared/meetingTypeSuggestion.js';
import type { ProcessingSchedule } from '../../shared/processingSchedule.js';
import type { FilingConfidence } from '../../shared/filing.js';
import type { PromptSuggestion, SuggestionView } from '../../shared/promptSuggestion.js';
export type { PromptSuggestion, SuggestionView };
import type { CalendarCoverage, CalendarImportResult } from '../../shared/calendar.js';
export type { CalendarCoverage, CalendarImportResult };

export type PipelineStep = 'download' | 'transcribe' | 'summarise' | 'write';

export interface InboxItemDTO {
  id: string;
  filename: string;
  duration_seconds: number | null;
  start_time: number | null;
  synced_at: number;
  status: RecordingStatus;
  currentStep: PipelineStep | null;
  /** 1-based position in this recording's own step plan, null when idle. */
  stepIndex: number | null;
  /** Total steps for this recording — 4 for Plaud, 2 for an imported transcript. */
  stepTotal: number;
  /** Path or id per destination; null where nothing was written. */
  outputs: {
    markdown: string | null;
    html: string | null;
    appleNote: string | null;
  };
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
  /** Jumps an idle/overnight processing schedule; see shared/processingSchedule.ts. */
  urgent: boolean;
  clientId: string | null;
  /** For a 'to_file' row, the meeting type the classifier picked and the summary was written with. */
  meetingTypeId: string | null;
  /** The classifier's client pick for a 'to_file' row; null when nothing clearly fitted. */
  suggestedClientId: string | null;
  filingConfidence: FilingConfidence | null;
  filingReason: string | null;
  /** Subject of the Outlook meeting this recording overlapped, from an imported calendar printout. */
  calendarSubject: string | null;
  /** Other meetings booked over the same recording (a double booking). */
  calendarAlternatives: string[];
  /** The transcript matched none of the booked meetings. */
  calendarRejected: boolean;
  /** The account that meeting points to, and why; a suggestion only. */
  calendarClientId: string | null;
  calendarClientName: string | null;
  /** Filed automatically at high confidence, not by the user. */
  autoFiled: boolean;
  calendarClientReason: string | null;
  /** Whether a "Full re-run" can re-transcribe this recording — a local audio file, or (Plaud only) a cloud copy to re-fetch. */
  audioAvailable: boolean;
  /** Effective per-destination targets: this row's override if it has one, else the current Settings -> Outputs default. */
  outputTargets: { markdown: boolean; html: boolean; appleNote: boolean };
}

export interface ClientDTO {
  id: string;
  name: string;
  is_builtin: boolean;
  sort_order: number;
  /** Account context added to every summary for this client; '' when none. */
  context: string;
}

export interface MeetingTypeDTO {
  id: string;
  name: string;
  prompt: string;
  is_builtin: boolean;
  sort_order: number;
  updated_at: number;
  is_modified: boolean;
  /** When to use this type; read by automatic matching ('' when none). */
  description: string;
  /** Kept for past recordings, no longer offered or auto-chosen. */
  retired: boolean;
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
  /** Minutes a completed recording stays in the Inbox's "Recent" section before it's auto-hidden. */
  autoDismissCompleteMinutes: number;
  /** Read from the OS, not from config — it can be changed in System Settings. */
  launchAtLogin: boolean;
  /**
   * False when running unpackaged: the login item would point at the
   * Electron dev binary rather than distill, so the toggle is inert.
   */
  launchAtLoginAvailable: boolean;
  processingSchedule: ProcessingSchedule;
  /** File "Queue all" recordings without Ready to file when confidence is high and the calendar agrees. */
  autoFileHighConfidence: boolean;
}

export interface PerformanceDTO {
  ollamaModel: string;
  ollamaKeepAlive: string;
  /** When true, num_ctx is sized per-recording instead of always allocating the full configured ceiling. */
  adaptiveContextWindow: boolean;
  whisperModel: string;
  transcriptionEngine: 'whisper' | 'parakeet';
  parakeetModel: string;
  /** Whether parakeet-mlx is importable in the venv right now — drives the Install button. */
  parakeetInstalled: boolean;
}

export type PlaudStatusDTO =
  | { signedIn: false }
  | { signedIn: true; email: string; region: string; tokenExpiresAt: number | null };

export interface SourcesDTO {
  plaud: PlaudStatusDTO;
}

export interface OutputDirStatusDTO {
  resolvedPath: string;
  exists: boolean;
  writable: boolean;
  willBeCreated: boolean;
  inICloudDrive: boolean;
  existingSummaries: number;
  problem: string | null;
  note: string | null;
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

export interface ParakeetInstallProgressDTO {
  phase: 'installing-packages' | 'verifying';
  log?: { stream: 'stdout' | 'stderr'; text: string };
}

export interface VocabularyBudgetDTO {
  /** Whisper's initial_prompt cap, in characters. */
  limit: number;
  used: number;
  hintsAvailable: number;
  hintsUsed: number;
  /** Every term that did not fit — these reach Whisper not at all. */
  dropped: string[];
}

export interface SettingsDTO {
  outputs: OutputsDTO;
  prompts: MeetingTypeDTO[];
  vocabularyScopes: VocabularyScopeDTO[];
  vocabularyBudget: VocabularyBudgetDTO;
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
  meeting: {
    open(recordingId: string, scope?: SearchScope): Promise<void>;
    get(recordingId: string): Promise<MeetingDetail>;
    correct(payload: {
      recordingId: string;
      from: string;
      to: string;
      rememberScope?: 'client' | 'organisation' | 'global' | null;
    }): Promise<{ applied: boolean; occurrences: number }>;
  };
  brief: {
    /** The client's meetings in the period, newest first. */
    listMeetings(clientId: string, sinceDays: number | null): Promise<BriefCandidate[]>;
    generate(payload: { clientId: string; recordingIds: string[] }): Promise<ClientBrief>;
    cancel(): Promise<void>;
  };
  register: {
    /** One client's items, newest first; omit clientId to list every client. */
    list(clientId?: string): Promise<RegisterItem[]>;
    add(payload: {
      clientId: string;
      kind: 'action' | 'decision';
      text: string;
      owner?: string | null;
      dueAt?: number | null;
      sourceRecordingId: string;
    }): Promise<RegisterItem>;
    setStatus(id: string, status: 'open' | 'done'): Promise<void>;
    delete(id: string): Promise<void>;
  };
  summaryVersions: {
    /** Newest first; always includes the live summary, synthesised if it predates this feature. */
    list(recordingId: string): Promise<SummaryVersionDTO[]>;
    generate(payload: {
      recordingId: string;
      model?: string;
      meetingTypeId?: string;
    }): Promise<{ version: SummaryVersionDTO; warning: string | null }>;
    cancel(): Promise<void>;
    activate(id: string): Promise<void>;
  };
  inbox: {
    search(query: string, scope: SearchScope): Promise<MeetingSearchResponse>;
    list(): Promise<InboxItemDTO[]>;
    skip(recordingId: string): Promise<void>;
    revealInFinder(recordingId: string): Promise<void>;
    revealOutput(recordingId: string, kind: 'markdown' | 'html' | 'appleNote'): Promise<void>;
    listHidden(): Promise<{ total: number; items: InboxItemDTO[] }>;
    unhide(recordingId: string): Promise<{ status: RecordingStatus }>;
    setOutputTargets(
      recordingId: string,
      targets: { markdown: boolean; html: boolean; appleNote: boolean },
    ): Promise<void>;
    /** Queue every untagged recording; each is classified and held at 'to_file' before writing. */
    queueAll(): Promise<{ queued: number }>;
    file(payload: { recordingId: string; clientId: string; meetingTypeId: string }): Promise<{ resummarise: boolean }>;
    /** Send a finished recording back to Ready to file (asks first; deletes its outputs). */
    refile(recordingId: string): Promise<{ refiled: boolean }>;
  };
  calendar: {
    coverage(): Promise<CalendarCoverage>;
    /** Opens a picker for calendar PDFs; null when cancelled. */
    importPdfs(): Promise<CalendarImportResult | null>;
  };
  pipeline: {
    cancel(recordingId: string): Promise<void>;
    retry(recordingId: string): Promise<void>;
    fullRerun(recordingId: string): Promise<{ started: boolean }>;
    /** Jump an idle/overnight processing schedule for this one recording. */
    setUrgent(recordingId: string, urgent: boolean): Promise<void>;
  };
  history: {
    list(payload: {
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<{ total: number; items: InboxItemDTO[] }>;
  };
  tag: {
    open(recordingId: string): Promise<void>;
    save(payload: {
      recordingId: string;
      clientId: string;
      meetingTypeId: string;
      attendees?: Attendee[];
      urgent?: boolean;
    }): Promise<void>;
    /** People from this client's past meetings, most frequent first. */
    frequentAttendees(clientId: string): Promise<FrequentAttendee[]>;
    /** A client id when attendees' email domains clearly point to one. */
    suggestClient(attendees: Attendee[]): Promise<string | null>;
    /** Local-Ollama guess at the best-fitting meeting type, from title/duration/client/attendees — no transcript exists yet at tag time. */
    suggestMeetingType(payload: {
      recordingId: string;
      clientId?: string;
      attendees: Attendee[];
    }): Promise<MeetingTypeSuggestion | null>;
    /** Addresses found on the clipboard, if any. */
    clipboardAttendees(): Promise<Attendee[]>;
    /** The Outlook meeting the recording overlapped (from an imported printout), or null. */
    calendarContext(recordingId: string): Promise<{
      /** Every meeting booked over the recording; more than one is a double booking. */
      meetings: {
        meetingId: string;
        subject: string;
        startMs: number;
        endMs: number;
        attendees: Attendee[];
        account: { id: string; name: string; reason: string } | null;
      }[];
    } | null>;
    getSheetRecordingId(): string | null;
  };
  clients: {
    list(): Promise<ClientDTO[]>;
    add(payload: { name: string }): Promise<ClientDTO>;
    /** Save the client's account context ('' clears it). */
    setContext(id: string, context: string): Promise<ClientDTO>;
  };
  meetingTypes: {
    list(): Promise<MeetingTypeDTO[]>;
    add(payload: { name: string; prompt: string }): Promise<MeetingTypeDTO>;
    delete(id: string): Promise<{ deletedId: string }>;
    updateMeta(id: string, patch: { description?: string | null; retired?: boolean }): Promise<MeetingTypeDTO>;
  };
  promptSuggestions: {
    /** New suggested meeting types, and updates to ones already added. */
    list(): Promise<SuggestionView[]>;
    /** Apply a suggestion by its key: add it, or update the existing type. */
    accept(key: string): Promise<MeetingTypeDTO>;
    dismiss(key: string): Promise<void>;
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
    /** Budget for hints currently in the editor, saved or not. */
    previewVocabularyBudget(payload: {
      scopeId: string;
      hints: string[];
    }): Promise<VocabularyBudgetDTO>;
    /** Resolves with the state that actually applied, which may differ from the request. */
    saveGeneral(payload: GeneralDTO): Promise<GeneralDTO>;
    savePerformance(payload: PerformanceDTO): Promise<void>;
    listOllamaModels(): Promise<OllamaModelsDTO>;
    browseFolder(currentPath?: string): Promise<string | null>;
    inspectOutputDir(dir: string): Promise<OutputDirStatusDTO>;
    revealPath(dir: string): Promise<void>;
    dismissModelSuggestion(): Promise<void>;
    pullModel(model: string): Promise<{ ok: true } | { ok: false; error: string }>;
    installParakeet(): Promise<{ ok: true } | { ok: false; error: string }>;
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
  onParakeetInstallProgress(handler: (p: ParakeetInstallProgressDTO) => void): () => void;
}

declare global {
  interface Window {
    distill: DistillApi;
  }
  /** Injected at build time by electron.vite.config.ts (Vite define). */
  const __APP_VERSION__: string;
}
