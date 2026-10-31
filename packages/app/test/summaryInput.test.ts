import { describe, expect, it } from 'vitest';
import { buildAccountContext, buildSummaryUserContent, MAX_ACCOUNT_CONTEXT_CHARS } from '../src/shared/summaryInput.js';

const attendees = JSON.stringify([{ name: 'Sam Lee', email: 'sam@example.com', company: null }]);

describe('buildSummaryUserContent', () => {
  it('puts account context, then the roster, then the transcript', () => {
    const out = buildSummaryUserContent({
      transcript: 'TRANSCRIPT',
      attendeesJson: attendees,
      account: { clientName: 'Acme', context: 'Glossary: CIM — campaign manager' },
    });
    const ctx = out.indexOf('Account context for Acme');
    const roster = out.indexOf('Meeting attendees');
    const transcript = out.indexOf('TRANSCRIPT');
    expect(ctx).toBe(0);
    expect(roster).toBeGreaterThan(ctx);
    expect(transcript).toBeGreaterThan(roster);
    expect(out).toContain('never report anything from them as said or decided in the meeting');
  });

  it('is just the transcript when there is no context or roster', () => {
    expect(buildSummaryUserContent({ transcript: 'T', attendeesJson: null })).toBe('T');
    expect(buildSummaryUserContent({ transcript: 'T', attendeesJson: null, account: { clientName: 'Acme', context: '  ' } })).toBe('T');
  });

  it('caps the context so it cannot crowd out the transcript', () => {
    const long = 'x'.repeat(MAX_ACCOUNT_CONTEXT_CHARS + 500);
    const block = buildAccountContext('Acme', long);
    expect(block.length).toBeLessThan(MAX_ACCOUNT_CONTEXT_CHARS + 300);
  });

  it('explains You/Others for a call recording, between the roster and the transcript', () => {
    const transcript = 'Others: Hello.\n\nYou: Hi.';
    const out = buildSummaryUserContent({ transcript, attendeesJson: attendees });
    const roster = out.indexOf('Meeting attendees');
    const legend = out.indexOf('"Others" is every other participant');
    expect(legend).toBeGreaterThan(roster);
    expect(out.indexOf('Others: Hello.')).toBeGreaterThan(legend);
  });

  it('adds no legend to an ordinary transcript, even one containing the word', () => {
    const out = buildSummaryUserContent({ transcript: 'Sam said the Others: group agreed.', attendeesJson: null });
    expect(out).toBe('Sam said the Others: group agreed.');
  });
});
