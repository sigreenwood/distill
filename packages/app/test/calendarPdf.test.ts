import { describe, expect, it } from 'vitest';
import { localTimeToMs, meetingId, toMeetings, type PrintedEvent } from '../src/main/calendar/pdfImport.js';
import { attendeesFromMatch, matchRecording, MAX_INVITE_ATTENDEES } from '../src/main/calendar/match.js';
import { accountFor, clientKeywords } from '../src/main/calendar/account.js';
import { buildFilingMessages, describeCalendarMatch } from '../src/main/filingSuggestion.js';
import type { CalendarMatch, CalendarMeeting } from '../src/shared/calendar.js';

const printed = (e: Partial<PrintedEvent>): PrintedEvent => ({
  subject: 'Sync', date: '2026-08-03', start: '09:00', end: '09:30', endDate: '2026-08-03', allDay: false,
  location: null, organiser: 'Tom Carroll', required: [], optional: [], body: null, ...e,
});
const at = (hhmm: string, date = '2026-08-03') => localTimeToMs(date, hhmm);
const meeting = (m: Partial<CalendarMeeting>): CalendarMeeting => ({
  id: m.subject ?? 'm', subject: 'Sync', startMs: at('09:00'), endMs: at('09:30'), location: null,
  organiser: 'Tom Carroll', required: [{ name: 'Sam Lee', email: 'sam@hsbc.com' }], optional: [], body: null, ...m,
});

describe('toMeetings', () => {
  it('converts printed local times, drops all-day entries and repeats across files', () => {
    const ms = toMeetings([
      printed({ subject: 'HSBC Daily Huddle' }),
      printed({ subject: 'HSBC Daily Huddle' }), // same event printed in two monthly files
      printed({ subject: 'On leave', start: null, end: null, allDay: true }),
      printed({ subject: 'Late', start: '23:00', end: '01:00', endDate: '2026-08-04' }),
    ]);
    expect(ms.map((m) => m.subject)).toEqual(['HSBC Daily Huddle', 'Late']);
    expect(ms[0].startMs).toBe(new Date(2026, 7, 3, 9, 0).getTime());
    expect(ms[1].endMs - ms[1].startMs).toBe(2 * 3600_000);
    expect(ms[0].id).toBe(meetingId({ date: '2026-08-03', start: '09:00', subject: 'HSBC Daily Huddle' }));
  });
});

describe('matchRecording', () => {
  const rec = (start: string, minutes: number) => ({ startMs: at(start), durationSeconds: minutes * 60 });

  it('picks the meeting the recording lines up with', () => {
    const m = matchRecording(rec('09:01', 28), [
      meeting({ id: 'a', subject: 'HSBC Daily Huddle' }),
      meeting({ id: 'b', subject: 'Workshop', startMs: at('08:00'), endMs: at('12:00') }),
    ]);
    expect(m?.subject).toBe('HSBC Daily Huddle');
    expect(m?.alternative).toBeNull();
  });

  it('prefers a real meeting over a personal block like Lunch', () => {
    const m = matchRecording(rec('12:00', 60), [
      meeting({ id: 'lunch', subject: 'Lunch', startMs: at('12:00'), endMs: at('13:00'), organiser: null, required: [] }),
      meeting({ id: 'call', subject: 'AIB Catchup', startMs: at('12:00'), endMs: at('12:45') }),
    ]);
    expect(m?.subject).toBe('AIB Catchup');
  });

  it('skips cancelled meetings and mere touching, and flags double bookings', () => {
    expect(matchRecording(rec('09:00', 30), [meeting({ subject: 'Canceled: AIB/Teradata: Weekly sync' })])).toBeNull();
    expect(matchRecording(rec('09:27', 30), [meeting({})])).toBeNull();
    const m = matchRecording(rec('09:00', 30), [meeting({ id: 'a', subject: 'A' }), meeting({ id: 'b', subject: 'B' })]);
    expect(m?.alternative).toBe('B');
  });
});

describe('attendeesFromMatch', () => {
  const match = (m: Partial<CalendarMatch>): CalendarMatch => ({
    meetingId: 'm', subject: 's', startMs: 0, endMs: 0, organiser: null, body: null, alternative: null,
    attendees: [{ name: 'Sam Lee', email: 'sam@hsbc.com' }, { name: 'Sam Lee', email: 'sam@hsbc.com' }], ...m,
  });
  it('de-duplicates, and gives nothing for an ambiguous match or a mass invite', () => {
    expect(attendeesFromMatch(match({}))).toEqual([{ name: 'Sam Lee', email: 'sam@hsbc.com', company: null }]);
    expect(attendeesFromMatch(match({ alternative: 'Other' }))).toEqual([]);
    const many = Array.from({ length: MAX_INVITE_ATTENDEES + 1 }, (_, i) => ({ name: `P${i}`, email: `p${i}@x.com` }));
    expect(attendeesFromMatch(match({ attendees: many }))).toEqual([]);
  });
});

describe('accountFor', () => {
  const clients = [
    { id: 'hsbc', name: 'HSBC' },
    { id: 'lbg', name: 'Lloyds Banking Group' },
    { id: 'aib', name: 'AIB' },
    { id: 'unclassified', name: 'Unclassified' },
  ];
  const m = (subject: string, emails: string[] = [], body: string | null = null) => ({
    subject,
    attendees: emails.map((email) => ({ name: email, email })),
    body,
  });

  it('derives keywords including the acronym account teams use', () => {
    expect(clientKeywords('Lloyds Banking Group')).toEqual(['lloyds banking group', 'lbg', 'lloyds']);
    expect(clientKeywords('HSBC')).toEqual(['hsbc']);
  });

  it('reads the account from the meeting title, internal meetings included', () => {
    expect(accountFor(m('HSBC Daily Huddle'), clients)?.clientId).toBe('hsbc');
    expect(accountFor(m('LBG: Daily stand up'), clients)?.clientId).toBe('lbg');
    expect(accountFor(m('Lloyds: DataDNA weekly catch up'), clients)?.clientId).toBe('lbg');
    expect(accountFor(m('LBG: Daily stand up'), clients)?.reason).toContain('mentions LBG');
  });

  it('falls back to invitee domains, then the invite text', () => {
    expect(accountFor(m('[EXTERNAL] Teradata QTR2 QBR', ['a@teradata.com', 'b@aib.ie']), clients)?.clientId).toBe('aib');
    expect(accountFor(m('Service Review', ['x@uk.hsbc.co.in']), clients)?.reason).toContain('hsbc.co.in');
    expect(accountFor(m('Weekly sync', ['p@lloydsbanking.com']), clients)?.clientId).toBe('lbg');
    expect(accountFor(m('Prep', [], 'Agenda for the AIB workshop'), clients)?.clientId).toBe('aib');
  });

  it('suggests nothing for a tie or no evidence, and never Unclassified', () => {
    expect(accountFor(m('Check in on HSBC and AIB'), clients)).toBeNull();
    expect(accountFor(m('Weekly Growth CSA Team Meeting', ['a@teradata.com']), clients)).toBeNull();
    expect(accountFor(m('Unclassified bits'), clients)).toBeNull();
  });

  it('does not match a keyword inside another word', () => {
    expect(accountFor(m('Haibun poetry'), clients)).toBeNull();
  });
});

describe('classifier prompt with a calendar meeting', () => {
  const match: CalendarMatch = {
    meetingId: 'm', subject: 'HSBC Daily Huddle', startMs: 0, endMs: 0, organiser: 'Tom Carroll',
    attendees: [{ name: 'Sam Lee', email: 'sam@hsbc.com' }], body: 'Daily HSBC huddle', alternative: 'Lunch',
  };

  it('describes the meeting with domains, not addresses', () => {
    const lines = describeCalendarMatch(match, 'HSBC (the meeting title mentions HSBC)').join('\n');
    expect(lines).toContain('"HSBC Daily Huddle"');
    expect(lines).toContain('Sam Lee (hsbc.com)');
    expect(lines).not.toContain('sam@');
    expect(lines).toContain('"Lunch"');
    expect(lines).toContain('Account indicated by the calendar: HSBC');
  });

  it('is included in the filing request', () => {
    const user = buildFilingMessages(
      { title: 't', durationSeconds: 60, transcript: 'x', calendar: match, calendarAccount: 'HSBC' },
      [{ id: 'hsbc', name: 'HSBC' }],
      [{ id: 't', name: 'Client call', prompt: 'p' }],
    ).messages[1].content;
    expect(user).toContain('Calendar meeting at the time of the recording');
  });
});
