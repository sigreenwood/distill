import { describe, expect, it } from 'vitest';
import { localTimeToMs, meetingId, toMeetings, validateCalendarPdfPaths, type PrintedEvent } from '../src/main/calendar/pdfImport.js';
import { attendeesFromMatch, chooseCandidate, matchRecording, MAX_INVITE_ATTENDEES } from '../src/main/calendar/match.js';
import { accountFor, accountForMatch, clientKeywords } from '../src/main/calendar/account.js';
import { buildFilingMessages, describeCalendarCandidates, parseFilingSuggestion } from '../src/main/filingSuggestion.js';
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

describe('validateCalendarPdfPaths', () => {
  it('accepts PDF extensions regardless of case, and removes repeated normalized paths', () => {
    expect(validateCalendarPdfPaths([
      '/Users/sam/Calendar.PDF',
      '/Users/sam/./Calendar.PDF',
      '/Users/sam/Next month.pdf',
    ])).toEqual(['/Users/sam/Calendar.PDF', '/Users/sam/Next month.pdf']);
  });

  it.each([undefined, null, [], '/Users/sam/Calendar.pdf', {}, [42], [''], ['Calendar.pdf'], ['file:///Calendar.pdf'], ['/tmp/Calendar.mp3'], ['/tmp/Calendar.pdf\0']])(
    'rejects invalid input %j', (value) => {
      expect(() => validateCalendarPdfPaths(value)).toThrow();
    },
  );

  it('rejects the whole batch when one path is not a PDF', () => {
    expect(() => validateCalendarPdfPaths(['/tmp/Calendar.pdf', '/tmp/audio.m4a'])).toThrow('PDF files');
  });
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
    const m = matchRecording(rec('09:01', 28), [meeting({ id: 'a', subject: 'HSBC Daily Huddle' })]);
    expect(m?.subject).toBe('HSBC Daily Huddle');
    expect(m?.alternatives).toEqual([]);
  });

  it('keeps every real meeting booked over the recording, not just the best time fit', () => {
    // A 20-minute recording: the 30-minute call fits the clock better, but
    // the hour-long one booked at the same time is just as possible.
    const m = matchRecording(rec('14:00', 20), [
      meeting({ id: 'a', subject: 'Account weekly catch-up', startMs: at('14:00'), endMs: at('14:30') }),
      meeting({ id: 'b', subject: 'Advisory board', startMs: at('14:00'), endMs: at('15:00') }),
    ])!;
    expect(m.subject).toBe('Account weekly catch-up');
    expect(m.alternatives.map((a) => a.subject)).toEqual(['Advisory board']);
  });

  it('lists back-to-back meetings a long recording runs across', () => {
    const m = matchRecording(rec('08:00', 90), [
      meeting({ id: 'a', subject: 'Huddle', startMs: at('08:00'), endMs: at('08:30') }),
      meeting({ id: 'b', subject: 'Stand-up', startMs: at('08:30'), endMs: at('08:55') }),
      meeting({ id: 'c', subject: 'Community call', startMs: at('08:30'), endMs: at('09:30') }),
    ])!;
    expect([m.subject, ...m.alternatives.map((a) => a.subject)].sort()).toEqual(['Community call', 'Huddle', 'Stand-up']);
  });

  it('ignores personal blocks when a real meeting is booked, but uses one when nothing else is', () => {
    const lunch = meeting({ id: 'lunch', subject: 'Lunch', startMs: at('12:00'), endMs: at('13:00'), organiser: null, required: [] });
    const m = matchRecording(rec('12:00', 45), [lunch, meeting({ id: 'call', subject: 'AIB Catchup', startMs: at('12:00'), endMs: at('12:45') })])!;
    expect(m.subject).toBe('AIB Catchup');
    expect(m.alternatives).toEqual([]);
    expect(matchRecording(rec('12:00', 45), [lunch])?.subject).toBe('Lunch');
  });

  it('skips cancelled meetings and mere touching', () => {
    expect(matchRecording(rec('09:00', 30), [meeting({ subject: 'Canceled: AIB/Teradata: Weekly sync' })])).toBeNull();
    expect(matchRecording(rec('09:27', 30), [meeting({})])).toBeNull();
  });

  it('turns a chosen candidate into the match, alternatives cleared', () => {
    const m = matchRecording(rec('09:00', 30), [meeting({ id: 'a', subject: 'A' }), meeting({ id: 'b', subject: 'B' })])!;
    const chosen = chooseCandidate(m, 'b')!;
    expect(chosen.subject).toBe('B');
    expect(chosen.alternatives).toEqual([]);
    expect(chosen.confirmedByTranscript).toBe(true);
    expect(chooseCandidate(m, 'nope')).toBeNull();
  });
});

describe('attendeesFromMatch', () => {
  const match = (m: Partial<CalendarMatch>): CalendarMatch => ({
    meetingId: 'm', subject: 's', startMs: 0, endMs: 0, organiser: null, body: null, alternatives: [],
    attendees: [{ name: 'Sam Lee', email: 'sam@hsbc.com' }, { name: 'Sam Lee', email: 'sam@hsbc.com' }], ...m,
  });
  it('de-duplicates, and gives nothing for a double booking or a mass invite', () => {
    expect(attendeesFromMatch(match({}))).toEqual([{ name: 'Sam Lee', email: 'sam@hsbc.com', company: null }]);
    expect(attendeesFromMatch(match({ alternatives: [match({})] }))).toEqual([]);
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

  it('with overlapping meetings, suggests an account only when every meeting agrees', () => {
    const withAlts = (subject: string, ...alts: string[]) => ({ ...m(subject), alternatives: alts.map((a) => m(a)) });
    expect(accountForMatch(withAlts('HSBC Daily Huddle', 'HSBC CIM catch-up'), clients)?.clientId).toBe('hsbc');
    expect(accountForMatch(withAlts('HSBC Daily Huddle', 'AIB POC'), clients)).toBeNull();
    // A meeting with no account counts against: it could have been the all-hands.
    expect(accountForMatch(withAlts('HSBC AI Studio - Internal', 'CSA All-Hands'), clients)).toBeNull();
    expect(accountForMatch({ ...m('HSBC Daily Huddle'), alternatives: [], rejectedByTranscript: true } as never, clients)).toBeNull();
  });
});

describe('classifier prompt with calendar meetings', () => {
  const huddle: CalendarMatch = {
    meetingId: 'h', subject: 'HSBC Daily Huddle', startMs: at('09:00'), endMs: at('09:30'), organiser: 'Tom Carroll',
    attendees: [{ name: 'Sam Lee', email: 'sam@hsbc.com' }], body: 'Daily HSBC huddle',
    alternatives: [{ meetingId: 'p', subject: 'AIB POC', startMs: at('09:00'), endMs: at('10:00'), organiser: null, attendees: [], body: null }],
  };

  it('lists every booked meeting with domains, not addresses, and its account', () => {
    const lines = describeCalendarCandidates([huddle, ...huddle.alternatives], ['HSBC (title)', 'AIB (title)']).join('\n');
    expect(lines).toContain('M1: "HSBC Daily Huddle"');
    expect(lines).toContain('M2: "AIB POC"');
    expect(lines).toContain('Sam Lee (hsbc.com)');
    expect(lines).not.toContain('sam@');
    expect(lines).toContain('Account indicated: AIB (title)');
  });

  it('asks which meeting the transcript matches, and maps the answer back', () => {
    const built = buildFilingMessages(
      { title: 't', durationSeconds: 60, transcript: 'x', calendar: huddle, candidateAccounts: [] },
      [{ id: 'hsbc', name: 'HSBC' }],
      [{ id: 't', name: 'Client call', prompt: 'p' }],
    );
    expect(built.meetingIds).toEqual(['h', 'p']);
    expect(built.messages[1].content).toContain('2 overlap');
    const parse = (meeting: string) =>
      parseFilingSuggestion(
        JSON.stringify({ client: 'C1', type: 'T1', confidence: 'high', meeting }),
        ['C1'], ['T1'], [{ id: 'hsbc', name: 'HSBC' }], [{ id: 't', name: 'Client call', prompt: 'p' }], built.meetingIds,
      )!;
    expect(parse('M2').meetingId).toBe('p');
    expect(parse('none').meetingId).toBeNull();
    expect('meetingId' in parse('M9')).toBe(false);
  });
});
