/**
 * Which calendar meeting was this recording? Scored by overlap over union,
 * so a call inside a long block still prefers the invite that lines up
 * with it. On three months of real recordings this matched 203 of 249,
 * 133 of them starting within five minutes of the meeting.
 */
import type { CalendarMatch, CalendarMeeting, CalendarPerson } from '../../shared/calendar.js';
import type { Attendee } from '../../shared/attendees.js';

/** Plaud usually knows the duration; a dragged-in file may not. */
const ASSUMED_DURATION_MS = 30 * 60_000;
/** Offsites, holidays and travel days aren't meetings that get recorded. */
const MAX_MEETING_MS = 8 * 3600_000;
/** A runner-up scoring at least this fraction of the best is shown alongside it. */
const AMBIGUOUS_RATIO = 0.8;
/** A block nobody was invited to (Lunch, travel, focus time) loses to a real meeting. */
const PERSONAL_BLOCK_WEIGHT = 0.5;
export const SEARCH_MARGIN_MS = 12 * 3600_000;

function isCancelled(subject: string): boolean {
  return /^(canceled|cancelled)\s*:/i.test(subject.trim());
}

function isPersonalBlock(m: CalendarMeeting): boolean {
  return !m.organiser && m.required.length === 0 && m.optional.length === 0;
}

export function matchRecording(
  recording: { startMs: number; durationSeconds: number | null },
  meetings: CalendarMeeting[],
): CalendarMatch | null {
  const recStart = recording.startMs;
  const recEnd = recStart + (recording.durationSeconds ? recording.durationSeconds * 1000 : ASSUMED_DURATION_MS);
  // Enough overlap that it isn't just the tail of the previous meeting:
  // 5 minutes, or half of a recording shorter than 10.
  const minOverlap = Math.min(5 * 60_000, (recEnd - recStart) / 2);
  const scored: { meeting: CalendarMeeting; score: number }[] = [];
  for (const m of meetings) {
    if (m.endMs - m.startMs > MAX_MEETING_MS || isCancelled(m.subject)) continue;
    const overlap = Math.min(recEnd, m.endMs) - Math.max(recStart, m.startMs);
    if (overlap < minOverlap) continue;
    const union = Math.max(recEnd, m.endMs) - Math.min(recStart, m.startMs);
    scored.push({ meeting: m, score: (overlap / union) * (isPersonalBlock(m) ? PERSONAL_BLOCK_WEIGHT : 1) });
  }
  if (scored.length === 0) return null;
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Math.abs(a.meeting.startMs - recStart) - Math.abs(b.meeting.startMs - recStart),
  );
  const [best, second] = scored;
  const m = best.meeting;
  return {
    meetingId: m.id,
    subject: m.subject,
    startMs: m.startMs,
    endMs: m.endMs,
    organiser: m.organiser,
    attendees: [...m.required, ...m.optional],
    body: m.body,
    alternative: second && second.score >= best.score * AMBIGUOUS_RATIO ? second.meeting.subject : null,
  };
}

/** Cap for attendees taken from an invite: a 200-person all-hands list helps nobody. */
export const MAX_INVITE_ATTENDEES = 25;

/**
 * Invitees as the recording's attendee list — the same shape the tag sheet
 * stores, so Whisper hints and the summary roster use them unchanged.
 * Empty when the match is ambiguous (naming the wrong meeting's people
 * would mislead both) or the invite is too big to be a guest list.
 */
export function attendeesFromMatch(match: CalendarMatch): Attendee[] {
  if (match.alternative || match.attendees.length > MAX_INVITE_ATTENDEES) return [];
  const seen = new Set<string>();
  const out: Attendee[] = [];
  for (const p of match.attendees as CalendarPerson[]) {
    const key = (p.email ?? p.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: p.name, email: p.email, company: null });
  }
  return out;
}
