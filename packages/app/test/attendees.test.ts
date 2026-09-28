import { describe, it, expect } from 'vitest';
import {
  buildAttendeeRoster,
  mergeAttendees,
  parseAttendeesText,
  parseStoredAttendees,
  rankFrequentAttendees,
  suggestClientId,
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

describe('rankFrequentAttendees', () => {
  const jane = { name: 'Jane', email: 'jane@aib.ie', company: 'Aib' };
  const bob = { name: 'Bob', email: 'bob@aib.ie', company: 'Aib' };
  const cara = { name: 'Cara', email: null, company: null };

  it('orders by meetings attended, then recency', () => {
    const ranked = rankFrequentAttendees([[cara], [jane, bob], [jane]]);
    expect(ranked.map((a) => [a.name, a.meetings])).toEqual([
      ['Jane', 2],
      ['Cara', 1],
      ['Bob', 1],
    ]);
  });

  it('keeps the most recent spelling and counts a person once per meeting', () => {
    const ranked = rankFrequentAttendees([
      [{ ...jane, name: 'Jane Smith' }, jane],
      [jane],
    ]);
    expect(ranked).toEqual([{ ...jane, name: 'Jane Smith', meetings: 2 }]);
  });
});

describe('suggestClientId', () => {
  const clients = [
    { id: 'aib', name: 'AIB' },
    { id: 'hsbc', name: 'HSBC' },
    { id: 'lloyds', name: 'Lloyds Banking Group' },
    { id: 'unclassified', name: 'Unclassified' },
  ];
  const me = { name: 'Me', email: 'me@teradata.com', company: 'Teradata' };
  const at = (email: string) => ({ name: email, email, company: null });

  it('matches an unseen domain to a client name', () => {
    expect(suggestClientId([me, at('x@aib.ie')], [], clients)).toBe('aib');
    expect(suggestClientId([at('x@lloydsbanking.com')], [], clients)).toBe('lloyds');
  });

  it("learns a domain from past tagging even when it doesn't look like the name", () => {
    const history = [{ clientId: 'hsbc', attendees: [at('a@hsbcbank.co.uk')] }];
    expect(suggestClientId([at('b@hsbcbank.co.uk')], history, clients)).toBe('hsbc');
  });

  it("ignores your own company's domain, which is in every meeting", () => {
    const history = [
      { clientId: 'aib', attendees: [me, at('a@aib.ie')] },
      { clientId: 'aib', attendees: [me, at('b@aib.ie')] },
      { clientId: 'hsbc', attendees: [me, at('c@hsbc.com')] },
    ];
    expect(suggestClientId([me], history, clients)).toBeNull();
    expect(suggestClientId([me, at('d@hsbc.com')], history, clients)).toBe('hsbc');
  });

  it('declines when attendees point at two clients equally', () => {
    expect(suggestClientId([at('x@aib.ie'), at('y@hsbc.com')], [], clients)).toBeNull();
  });

  it('declines with no usable email domains', () => {
    expect(suggestClientId([{ name: 'Jane', email: null, company: null }, at('x@gmail.com')], [], clients)).toBeNull();
  });
});
