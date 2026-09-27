import { describe, it, expect } from 'vitest';
import {
  buildAttendeeRoster,
  mergeAttendees,
  parseAttendeesText,
  parseStoredAttendees,
} from '../src/shared/attendees.js';

describe('parseAttendeesText', () => {
  it('parses Outlook "Name <email>" lists', () => {
    expect(parseAttendeesText('Jane Smith <Jane.Smith@example.co.uk>; Bob Jones <bob@acme.com>')).toEqual([
      { name: 'Jane Smith', email: 'jane.smith@example.co.uk', company: 'Example' },
      { name: 'Bob Jones', email: 'bob@acme.com', company: 'Acme' },
    ]);
  });

  it('guesses a name from a bare email and drops webmail as a company', () => {
    expect(parseAttendeesText('mary-ann.oneill@gmail.com')).toEqual([
      { name: 'Mary Ann Oneill', email: 'mary-ann.oneill@gmail.com', company: null },
    ]);
  });

  it('keeps plain names and ignores separators-only noise', () => {
    expect(parseAttendeesText('Aoife, Connor;\n ; 123')).toEqual([
      { name: 'Aoife', email: null, company: null },
      { name: 'Connor', email: null, company: null },
    ]);
  });

  it('does not double-count an email already matched with its name', () => {
    expect(parseAttendeesText('Jane <jane@acme.com>')).toHaveLength(1);
  });
});

describe('mergeAttendees', () => {
  it('skips duplicates by email, else by name, case-insensitively', () => {
    const existing = [
      { name: 'Jane', email: 'jane@acme.com', company: 'Acme' },
      { name: 'Connor', email: null, company: null },
    ];
    const merged = mergeAttendees(existing, [
      { name: 'Jane S', email: 'JANE@acme.com', company: 'Acme' },
      { name: 'connor', email: null, company: null },
      { name: 'Claire', email: null, company: null },
    ]);
    expect(merged.map((a) => a.name)).toEqual(['Jane', 'Connor', 'Claire']);
  });
});

describe('stored attendees', () => {
  it('treats null or malformed JSON as no attendees', () => {
    expect(parseStoredAttendees(null)).toEqual([]);
    expect(parseStoredAttendees('{not json')).toEqual([]);
    expect(parseStoredAttendees('{"name":"x"}')).toEqual([]);
  });

  it('drops entries without a name', () => {
    expect(parseStoredAttendees('[{"name":"A","email":null,"company":null},{"email":"x@y.z"}]')).toEqual([
      { name: 'A', email: null, company: null },
    ]);
  });

  it('builds a roster only when there is someone to list', () => {
    expect(buildAttendeeRoster([])).toBe('');
    expect(
      buildAttendeeRoster([
        { name: 'Jane', email: null, company: 'Acme' },
        { name: 'Bob', email: null, company: null },
      ]),
    ).toBe('Meeting attendees (from calendar invite):\n- Jane (Acme)\n- Bob');
  });
});
