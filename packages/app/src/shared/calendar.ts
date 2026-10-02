/**
 * Meetings read from an Outlook calendar printed to PDF (see
 * python/calendar_pdf.py and main/calendar/), used to say which meeting a
 * recording was, who was in it, and which account it belongs to.
 */

export interface CalendarPerson {
  name: string;
  email: string | null;
}

export interface CalendarMeeting {
  /** Stable across re-imports of the same month: date, start and subject. */
  id: string;
  subject: string;
  /** Epoch ms. The printout shows local wall-clock times, converted with the Mac's time zone. */
  startMs: number;
  endMs: number;
  location: string | null;
  organiser: string | null;
  required: CalendarPerson[];
  optional: CalendarPerson[];
  /** The invite text, without the Teams/Webex dial-in block and recording notice. */
  body: string | null;
}

/** A calendar meeting that overlapped a recording. */
export interface CalendarCandidate {
  meetingId: string;
  subject: string;
  startMs: number;
  endMs: number;
  organiser: string | null;
  attendees: CalendarPerson[];
  body: string | null;
}

/**
 * The meeting a recording overlapped, as stored on the recording. Calendars
 * are double-booked often (46 of 203 matched recordings in three real
 * months), so every other meeting that also covers the recording is kept
 * as an alternative rather than silently picking one by time.
 */
export interface CalendarMatch extends CalendarCandidate {
  /** Other meetings covering the recording, best time fit first. */
  alternatives: CalendarCandidate[];
  /** The transcript was checked against the candidates and this one chosen. */
  confirmedByTranscript?: boolean;
  /** The transcript matched none of the booked meetings: a call in a booked slot. No account or invitees are taken from it. */
  rejectedByTranscript?: boolean;
}

/** Which account (client) a meeting belongs to, and the evidence. */
export interface AccountSuggestion {
  clientId: string;
  reason: string;
}

export interface CalendarCoverage {
  meetings: number;
  firstMs: number | null;
  lastMs: number | null;
  importedAt: number | null;
}

export interface CalendarImportResult {
  files: { name: string; meetings: number; warnings: string[] }[];
  meetings: number;
  /** Recordings in the imported period that overlapped a meeting. */
  matched: number;
  /** Of those, how many gained an account suggestion. */
  accountsSuggested: number;
}
