/**
 * Meeting attendees, shared between the tag sheet (which parses pasted
 * invite text client-side) and the main process (which stores them as
 * JSON on the recording and feeds them to the pipeline).
 *
 * Attendees do two jobs downstream:
 *   - their names are prepended to the Whisper hints for that one
 *     recording, so unusual names are spelt correctly in the transcript;
 *   - a short roster is prepended to the transcript sent to Ollama, so
 *     the summary can attribute actions to the right people.
 *
 * A recording tagged without attendees behaves exactly as before: no
 * extra hints, no roster.
 */

export interface Attendee {
  name: string;
  email: string | null;
  company: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// "Jane Smith <jane.smith@example.com>" — Outlook's copy format.
const NAME_EMAIL_RE = new RegExp(`([^<>,;\\n]+?)\\s*<\\s*(${EMAIL_RE.source})\\s*>`, 'g');
const BARE_EMAIL_RE = new RegExp(EMAIL_RE.source, 'g');

// Webmail domains say nothing about who someone works for.
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

// The "co" in example.co.uk — skipped when picking the company label.
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

function titleCaseWord(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** "jane.smith" → "Jane Smith". Best effort for bare addresses. */
function guessNameFromLocalPart(localPart: string): string {
  const segments = localPart.split(/[._-]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return titleCaseWord(localPart);
  return segments.map(titleCaseWord).join(' ');
}

/** "aib.ie" → "Aib", "example.co.uk" → "Example", "gmail.com" → null. */
function companyFromDomain(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (PERSONAL_EMAIL_DOMAINS.has(lower)) return null;
  const parts = lower.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let labelParts = parts.slice(0, -1);
  if (labelParts.length > 1 && SECOND_LEVEL_SUFFIXES.has(labelParts[labelParts.length - 1])) {
    labelParts = labelParts.slice(0, -1);
  }
  const label = labelParts[labelParts.length - 1] ?? parts[0];
  return titleCaseWord(label);
}

/**
 * Parse raw invite text (an Outlook attendee list, a column of email
 * addresses, or plain names separated by commas/semicolons/newlines)
 * into attendees. Three passes, each consuming what it matched so the
 * next doesn't double-count: "Name <email>", then bare emails, then
 * whatever plain names are left.
 */
export function parseAttendeesText(raw: string): Attendee[] {
  const attendees: Attendee[] = [];
  let remaining = raw;

  remaining = remaining.replace(NAME_EMAIL_RE, (_whole, namePart: string, email: string) => {
    const name = namePart.trim();
    if (name.length > 0) {
      const domain = email.split('@')[1] ?? '';
      attendees.push({ name, email: email.toLowerCase(), company: companyFromDomain(domain) });
    }
    return '';
  });

  remaining = remaining.replace(BARE_EMAIL_RE, (email) => {
    const [localPart, domain] = email.split('@');
    attendees.push({
      name: guessNameFromLocalPart(localPart ?? email),
      email: email.toLowerCase(),
      company: companyFromDomain(domain ?? ''),
    });
    return '';
  });

  for (const chunk of remaining.split(/[,;\n]/)) {
    const name = chunk.trim();
    if (name.length > 0 && /[a-zA-Z]/.test(name)) {
      attendees.push({ name, email: null, company: null });
    }
  }
  return attendees;
}

/**
 * Append newly parsed attendees to an existing list, skipping anyone
 * already present (matched by email when there is one, else by name).
 */
export function mergeAttendees(existing: Attendee[], parsed: Attendee[]): Attendee[] {
  const merged = [...existing];
  for (const a of parsed) {
    const key = a.email ? a.email.toLowerCase() : a.name.trim().toLowerCase();
    const dupe = merged.some(
      (m) => (m.email ? m.email.toLowerCase() : m.name.trim().toLowerCase()) === key,
    );
    if (!dupe) merged.push(a);
  }
  return merged;
}

/**
 * Read `recordings.attendees_json` back into attendees. Tolerates NULL,
 * malformed JSON, and entries without a name — any of those just means
 * "no attendees", never a pipeline failure.
 */
export function parseStoredAttendees(json: string | null): Attendee[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is Attendee => !!a && typeof a === 'object' && typeof (a as Attendee).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * The roster block prepended to the transcript for summarisation.
 * Empty string when there are no attendees, so callers can test it.
 */
export function buildAttendeeRoster(attendees: Attendee[]): string {
  if (attendees.length === 0) return '';
  const lines = attendees.map((a) => (a.company ? `- ${a.name} (${a.company})` : `- ${a.name}`));
  return `Meeting attendees (from calendar invite):\n${lines.join('\n')}`;
}
