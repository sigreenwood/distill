// Re-export core types for use throughout the plugin
export type { PlaudRecording as PlaudFile, PlaudRecordingDetail as PlaudFileDetail } from '@plaud/core';

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: WhisperSegment[];
  language?: string;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'downloading' | 'transcribing' | 'error';
  message?: string;
  recordingId?: string;
  progress?: number;
}
