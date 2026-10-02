/**
 * Which calendar meeting was this recording? Every real meeting that covers
 * most of the recording (or most of which the recording covers) is a
 * candidate. They are ranked by overlap over union, but when there is more
 * than one the time fit alone can't say which meeting the user was in —
 * double bookings are common (46 of 203 matched recordings across three real
 * months, 30 of them pointing at different accounts) and one long recording
 * can run across back-to-back meetings. So all candidates are kept, and the
 * transcript (the filing classifier) or the user (the tag sheet) decides.
 */
import type { CalendarCandidate, CalendarMatch, CalendarMeeting } from '../../shared/calendar.js';
import type { Attendee } from '../../shared/attendees.js';

/** Plaud usually knows the duration; a dragged-in file may not. */
const ASSUMED_DURATION_MS = 30 * 60_000;
/** Offsites, holidays and travel days aren't meetings that get recorded. */
const MAX_MEETING_MS = 8 * 3600_000;
/** A meeting is a candidate when the overlap covers this much of the shorter of the two. */
const MIN_COVERAGE = 0.5;
/** At most this many alternatives are kept alongside the best fit. */
const MAX_ALTERNATIVES = 3;
export const SEARCH_MARGIN_MS = 12 * 3600_000;

function isCancelled(subject: string): boolean {
  return /^(canceled|cancelled)\s*:/i.test(subject.trim());
}

/** Lunch, travel, focus time: nobody invited. */
function isPersonalBlock(m: CalendarMeeting): boolean {
  return !m.organiser && m.required.length === 0 && m.optional.length === 0;
}

function toCandidate(m: CalendarMeeting): CalendarCandidate {
  return {
    meetingId: m.id,
    subject: m.subject,
    startMs: m.startMs,
    endMs: m.endMs,
    organiser: m.organiser,
    attendees: [...m.required, ...m.optional],
    body: m.body,
  };
}

export function matchRecording(
  recording: { startMs: number; durationSeconds: number | null },
  meetings: CalendarMeeting[],
): CalendarMatch | null {
  const recStart = recording.startMs;
  const recEnd = recStart + (recording.durationSeconds ? recording.durationSeconds * 1000 : ASSUMED_DURATION_MS);
  const recLength = recEnd - recStart;
  const scored: { meeting: CalendarMeeting; score: number }[] = [];
  for (const m of meetings) {
    if (m.endMs - m.startMs > MAX_MEETING_MS || isCancelled(m.subject)) continue;
    const overlap = Math.min(recEnd, m.endMs) - Math.max(recStart, m.startMs);
    if (overlap <= 0 || overlap / Math.min(recLength, m.endMs - m.startMs) < MIN_COVERAGE) continue;
    const union = Math.max(recEnd, m.endMs) - Math.min(recStart, m.startMs);
    scored.push({ meeting: m, score: overlap / union });
  }
  // A personal block only counts when there is no real meeting at all.
  const real = scored.filter((s) => !isPersonalBlock(s.meeting));
  const pool = real.length > 0 ? real : scored;
  if (pool.length === 0) return null;
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.meeting.startMs - recStart) - Math.abs(b.meeting.startMs - recStart),
  );
  const [best, ...rest] = pool;
  return {
    ...toCandidate(best.meeting),
    alternatives: rest.slice(0, MAX_ALTERNATIVES).map((s) => toCandidate(s.meeting)),
  };
}

/** The match with one of its candidates (by meeting id) made the primary, alternatives cleared. */
export function chooseCandidate(match: CalendarMatch, meetingId: string): CalendarMatch | null {
  const chosen = [match, ...match.alternatives].find((c) => c.meetingId === meetingId);
  if (!chosen) return null;
  const { meetingId: id, subject, startMs, endMs, organiser, attendees, body } = chosen;
  return { meetingId: id, subject, startMs, endMs, organiser, attendees, body, alternatives: [], confirmedByTranscript: true };
}

export function candidatesOf(match: CalendarMatch): CalendarCandidate[] {
  return [match, ...match.alternatives];
}

/** Cap for attendees taken from an invite: a 200-person all-hands list helps nobody. */
export const MAX_INVITE_ATTENDEES = 25;

/**
 * Invitees of a single meeting as an attendee list — the same shape the tag
 * sheet stores, so Whisper hints and the summary roster use them unchanged.
 * Empty when other meetings overlapped too (naming the wrong meeting's
 * people would mislead both) or the invite is too big to be a guest list.
 */
export function attendeesFromMatch(match: CalendarMatch): Attendee[] {
  if (match.alternatives.length > 0) return [];
  return attendeesOf(match);
}

export function attendeesOf(candidate: CalendarCandidate): Attendee[] {
  if (candidate.attendees.length > MAX_INVITE_ATTENDEES) return [];
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const p of candidate.attendees) {
    const key = (p.email ?? p.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, email: p.email, company: null });
  }
  return out;
}
