export interface MeetingText {
  text: string;
  source: 'database' | 'markdown';
}

export interface MeetingDetail {
  id: string;
  title: string;
  date: number;
  durationSeconds: number | null;
  client: string | null;
  clientId: string | null;
  meetingType: string | null;
  summary: MeetingText | null;
  transcript: MeetingText | null;
  truncationWarning: boolean;
  warning: string | null;
  canReveal: boolean;
  /**
   * Whether a transcript correction can be applied: the recording is
   * finished (complete/skipped, not still processing) and has a stored
   * transcript to correct — a Markdown-fallback transcript can't be
   * written back to, so correction stays unavailable for it.
   */
  canCorrect: boolean;
}
