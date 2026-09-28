import { describe, it, expect } from 'vitest';
import {
  parseAttendeesText,
  guessNameFromLocalPart,
  companyFromDomain,
  buildAttendeeRoster,
  parseStoredAttendees,
  rankFrequentAttendees,
  suggestClientId,
} from '../src/shared/attendees.js';

describe('guessNameFromLocalPart', () => {
  it('title-cases dot-separated segments in the order they appear', () => {
    expect(guessNameFromLocalPart('greenwood.simon')).toBe('Greenwood Simon');
  });

  it('handles underscore and hyphen separators', () => {
    expect(guessNameFromLocalPart('jane_doe')).toBe('Jane Doe');
    expect(guessNameFromLocalPart('john-smith')).toBe('John Smith');
  });

  it('falls back to title-casing the whole string when there is one segment', () => {
    expect(guessNameFromLocalPart('simon')).toBe('Simon');
  });
});

describe('companyFromDomain', () => {
  it('strips the TLD and title-cases the label', () => {
    expect(companyFromDomain('teradata.com')).toBe('Teradata');
  });

  it('drops a co/com second-level suffix (acme.co.uk)', () => {
    expect(companyFromDomain('acme.co.uk')).toBe('Acme');
  });

  it('uses the registered-domain label for a subdomain', () => {
    expect(companyFromDomain('mail.teradata.com')).toBe('Teradata');
  });

  it('returns null for personal email providers', () => {
    expect(companyFromDomain('gmail.com')).toBeNull();
    expect(companyFromDomain('outlook.com')).toBeNull();
  });
});

describe('parseAttendeesText', () => {
  it('parses "Name <email>" pairs, deriving company from the domain', () => {
    const result = parseAttendeesText('Simon Greenwood <greenwood.simon@teradata.com>');
    expect(result).toEqual([
      { name: 'Simon Greenwood', email: 'greenwood.simon@teradata.com', company: 'Teradata' },
    ]);
  });

  it('parses bare emails, guessing a name from the local-part', () => {
    const result = parseAttendeesText('doe.jane@acme.com');
    expect(result).toEqual([{ name: 'Doe Jane', email: 'doe.jane@acme.com', company: 'Acme' }]);
  });

  it('treats leftover text as plain names', () => {
    const result = parseAttendeesText('John Smith');
    expect(result).toEqual([{ name: 'John Smith', email: null, company: null }]);
  });

  it('handles a mixed Outlook-style paste: named pairs, bare emails, and plain names', () => {
    const raw =
      'Simon Greenwood <greenwood.simon@teradata.com>; doe.jane@acme.com; John Smith';
    const result = parseAttendeesText(raw);
    expect(result).toEqual([
      { name: 'Simon Greenwood', email: 'greenwood.simon@teradata.com', company: 'Teradata' },
      { name: 'Doe Jane', email: 'doe.jane@acme.com', company: 'Acme' },
      { name: 'John Smith', email: null, company: null },
    ]);
  });

  it('splits on newlines and commas as well as semicolons', () => {
    const result = parseAttendeesText('Alice Adams\nBob Baker, Carol Chen');
    expect(result.map((a) => a.name)).toEqual(['Alice Adams', 'Bob Baker', 'Carol Chen']);
  });

  it('returns an empty list for empty or whitespace-only input', () => {
    expect(parseAttendeesText('')).toEqual([]);
    expect(parseAttendeesText('   \n  ')).toEqual([]);
  });

  it('ignores stray punctuation left over between delimiters', () => {
    const result = parseAttendeesText('Simon Greenwood <greenwood.simon@teradata.com>; ; ;');
    expect(result).toEqual([
      { name: 'Simon Greenwood', email: 'greenwood.simon@teradata.com', company: 'Teradata' },
    ]);
  });
});

describe('buildAttendeeRoster', () => {
  it('returns an empty string for no attendees', () => {
    expect(buildAttendeeRoster([])).toBe('');
  });

  it('formats a roster with and without company', () => {
    const roster = buildAttendeeRoster([
      { name: 'Simon Greenwood', email: null, company: 'Teradata' },
      { name: 'Jane Doe', email: null, company: null },
    ]);
    expect(roster).toBe(
      'Meeting attendees (from calendar invite):\n- Simon Greenwood (Teradata)\n- Jane Doe',
    );
  });
});

describe('parseStoredAttendees', () => {
  it('returns [] for null', () => {
    expect(parseStoredAttendees(null)).toEqual([]);
  });

  it('returns [] for malformed JSON rather than throwing', () => {
    expect(parseStoredAttendees('not json')).toEqual([]);
  });

  it('returns [] for valid JSON that is not an array', () => {
    expect(parseStoredAttendees('{"name":"Simon"}')).toEqual([]);
  });

  it('round-trips a real attendee list', () => {
    const attendees = [{ name: 'Simon Greenwood', email: 'simon@teradata.com', company: 'Teradata' }];
    expect(parseStoredAttendees(JSON.stringify(attendees))).toEqual(attendees);
  });

  it('drops entries missing a name rather than failing the whole list', () => {
    const stored = JSON.stringify([{ email: 'no-name@x.com' }, { name: 'Valid Person' }]);
    expect(parseStoredAttendees(stored)).toEqual([{ name: 'Valid Person' }]);
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
