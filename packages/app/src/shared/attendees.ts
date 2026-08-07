/**
 * Parses a pasted block of meeting-invite text (Outlook's typical copy of
 * a "To:" line, or just a list of emails/names) into attendee entries.
 * Pure, framework-free — used directly by the tag sheet renderer for a
 * live, no-IPC preview, and the shape is what gets persisted on the
 * recording and later read back by the pipeline (see pipelineSteps.ts).
 */

export interface Attendee {
  name: string;
  email: string | null;
  company: string | null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const NAME_EMAIL_RE = new RegExp(`([^<>,;\\n]+?)\\s*<\\s*(${EMAIL_RE.source})\\s*>`, 'g');
const BARE_EMAIL_RE = new RegExp(EMAIL_RE.source, 'g');

// Free/personal providers aren't anyone's employer — leave company blank
// rather than label someone "Gmail" or "Outlook".
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

// Second-level labels that are part of the public suffix, not the
// organisation (acme.co.uk -> "Acme", not "Co").
const SECOND_LEVEL_SUFFIXES = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu']);

function titleCaseWord(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Best-effort name from an email local-part, e.g. "greenwood.simon" ->
 * "Greenwood Simon". Deliberately does NOT try to guess firstname/lastname
 * order — enterprises are inconsistent about it and a confident-but-wrong
 * reorder is worse than a predictable one the user can fix in the (always
 * editable) parsed list.
 */
export function guessNameFromLocalPart(localPart: string): string {
  const segments = localPart.split(/[._-]+/).filter((s) => s.length > 0);
  if (segments.length === 0) return titleCaseWord(localPart);
  return segments.map(titleCaseWord).join(' ');
}

/** Best-effort organisation name from an email domain, or null for personal providers. */
export function companyFromDomain(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (PERSONAL_EMAIL_DOMAINS.has(lower)) return null;
  const parts = lower.split('.').filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  let labelParts = parts.slice(0, -1); // drop the TLD
  if (labelParts.length > 1 && SECOND_LEVEL_SUFFIXES.has(labelParts[labelParts.length - 1])) {
    labelParts = labelParts.slice(0, -1); // drop a co/com/org second-level suffix (acme.co.uk)
  }
  const label = labelParts[labelParts.length - 1] ?? parts[0];
  return titleCaseWord(label);
}

/**
 * Parse a pasted invite block into attendees. Three passes, each removing
 * what it matched so later passes only see what's left:
 *   1. "Name <email>" pairs (Outlook's typical copy format).
 *   2. Bare emails.
 *   3. Whatever remains, split on , / ; / newline, as plain names.
 */
export function parseAttendeesText(raw: string): Attendee[] {
  const attendees: Attendee[] = [];
  let remaining = raw;

  remaining = remaining.replace(NAME_EMAIL_RE, (whole, namePart: string, email: string) => {
    const name = namePart.trim();
    if (name.length > 0) {
      const domain = email.split('@')[1] ?? '';
      attendees.push({ name, email: email.toLowerCase(), company: companyFromDomain(domain) });
    }
    return '';
  });

  remaining = remaining.replace(BARE_EMAIL_RE, (email: string) => {
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
 * Read back the `attendees_json` column. Tolerant of null/malformed data
 * (returns []) rather than throwing — a bad paste shouldn't be able to
 * fail transcription or summarisation, it should just mean no attendees.
 */
export function parseStoredAttendees(json: string | null): Attendee[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is Attendee =>
        !!a && typeof a === 'object' && typeof (a as Attendee).name === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * The block prepended to the summarisation user message when a recording
 * has attendees — gives the model names (and companies) to reference
 * instead of guessing from the transcript alone.
 */
export function buildAttendeeRoster(attendees: Attendee[]): string {
  if (attendees.length === 0) return '';
  const lines = attendees.map((a) => (a.company ? `- ${a.name} (${a.company})` : `- ${a.name}`));
  return `Meeting attendees (from calendar invite):\n${lines.join('\n')}`;
}
