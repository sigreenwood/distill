import type { AccountSuggestion, CalendarImportResult, CalendarMatch } from '../../shared/calendar.js';
import type { RecordingRow, State } from '../state.js';
import { accountFor } from './account.js';
import { attendeesFromMatch, matchRecording, SEARCH_MARGIN_MS } from './match.js';
import { readCalendarPdfs } from './pdfImport.js';

export function parseStoredMatch(json: string | null): CalendarMatch | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CalendarMatch;
  } catch {
    return null;
  }
}

/**
 * Match a recording against the imported calendar and store the result.
 * A recording with no overlapping meeting keeps whatever match it had.
 */
export function applyCalendarMatch(state: State, row: RecordingRow): CalendarMatch | null {
  if (row.start_time === null) return null;
  const meetings = state.listCalendarMeetingsBetween(row.start_time - SEARCH_MARGIN_MS, row.start_time + SEARCH_MARGIN_MS);
  const match = matchRecording({ startMs: row.start_time, durationSeconds: row.duration_seconds }, meetings);
  if (!match) return null;
  state.updateRecording(row.id, { calendar_match_json: JSON.stringify(match) });
  adoptCalendarAttendees(state, { ...row, calendar_match_json: JSON.stringify(match) });
  return match;
}

/**
 * For a recording queued with "Queue all" (which never sees the tag
 * sheet), the invitees become its attendees, so Whisper hints and the
 * summary roster use them as if pasted in. Only when it has none. A
 * recording tagged by hand is left alone: the sheet offers the invitees
 * and saves exactly what the user kept.
 */
export function adoptCalendarAttendees(state: State, row: RecordingRow): void {
  if (row.needs_filing !== 1 || row.attendees_json !== null) return;
  const match = parseStoredMatch(row.calendar_match_json);
  const attendees = match ? attendeesFromMatch(match) : [];
  if (attendees.length > 0) state.updateRecording(row.id, { attendees_json: JSON.stringify(attendees) });
}

/** The stored match, or a fresh one for a recording synced after the calendar was imported. */
export function ensureCalendarMatch(state: State, row: RecordingRow): CalendarMatch | null {
  return parseStoredMatch(row.calendar_match_json) ?? applyCalendarMatch(state, row);
}

/** The account the recording's calendar meeting points to, if any. */
export function calendarAccountFor(state: State, row: Pick<RecordingRow, 'calendar_match_json'>): AccountSuggestion | null {
  const match = parseStoredMatch(row.calendar_match_json);
  return match ? accountFor(match, state.listClients()) : null;
}

export async function importCalendarPdfs(
  state: State,
  files: string[],
  python: { binary: string; script: string },
): Promise<CalendarImportResult> {
  const { meetings, files: summary } = await readCalendarPdfs(python.binary, python.script, files);
  state.replaceCalendarMeetings(meetings);
  let matched = 0;
  let accountsSuggested = 0;
  if (meetings.length > 0) {
    const from = meetings[0].startMs - SEARCH_MARGIN_MS;
    const to = meetings[meetings.length - 1].endMs + SEARCH_MARGIN_MS;
    const clients = state.listClients();
    for (const row of state.listRecordingsStartedBetween(from, to)) {
      const match = applyCalendarMatch(state, row);
      if (!match) continue;
      matched++;
      if (accountFor(match, clients)) accountsSuggested++;
    }
  }
  return { files: summary, meetings: meetings.length, matched, accountsSuggested };
}
