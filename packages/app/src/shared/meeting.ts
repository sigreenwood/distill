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
  meetingTypeId: string | null;
  summary: MeetingText | null;
  transcript: MeetingText | null;
  truncationWarning: boolean;
  warning: string | null;
  canReveal: boolean;
  /**
   * Whether the stored transcript can be acted on directly: the
   * recording is finished (complete/skipped, not still processing) and
   * has a stored transcript — a Markdown-fallback transcript can't be
   * written back to. Gates both "Correct a word or phrase…" and
   * "Versions…" (generating an alternative summary needs the same
   * stored transcript a correction does).
   */
  canCorrect: boolean;
}
