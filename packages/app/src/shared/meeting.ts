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
  meetingType: string | null;
  summary: MeetingText | null;
  transcript: MeetingText | null;
  truncationWarning: boolean;
  warning: string | null;
  canReveal: boolean;
}
