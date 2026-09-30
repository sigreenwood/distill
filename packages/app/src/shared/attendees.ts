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

// --- suggestions from past meetings ----------------------------------------

export function attendeeKey(a: Attendee): string {
  return a.email ? a.email.toLowerCase() : a.name.trim().toLowerCase();
}

export interface FrequentAttendee extends Attendee {
  /** How many of the given meetings this person was in. */
  meetings: number;
}

/**
 * People who come up most across past meetings, for one-click re-adding.
 * `history` is newest first; each person keeps the spelling from their
 * most recent meeting, and ties go to whoever was seen most recently.
 */
export function rankFrequentAttendees(history: Attendee[][], limit = 12): FrequentAttendee[] {
  const byKey = new Map<string, FrequentAttendee & { firstSeen: number }>();
  history.forEach((meeting, index) => {
    const seenHere = new Set<string>();
    for (const a of meeting) {
      const key = attendeeKey(a);
      if (seenHere.has(key)) continue;
      seenHere.add(key);
      const existing = byKey.get(key);
      if (existing) existing.meetings += 1;
      else byKey.set(key, { ...a, meetings: 1, firstSeen: index });
    }
  });
  return [...byKey.values()]
    .sort((x, y) => y.meetings - x.meetings || x.firstSeen - y.firstSeen)
    .slice(0, limit)
    .map(({ firstSeen: _firstSeen, ...a }) => a);
}

function emailDomain(email: string | null): string | null {
  const domain = email?.split('@')[1]?.toLowerCase();
  return domain && !PERSONAL_EMAIL_DOMAINS.has(domain) ? domain : null;
}

function normaliseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Guess the client from attendees' email domains.
 *
 * A domain seen in past tagged meetings votes for clients in proportion
 * to how its meetings were tagged, so a client's own domain votes almost
 * entirely for that client. A domain in more than half of all past
 * meetings — in practice your own company's — says nothing about the
 * client, so it falls back to matching the domain against client names
 * (aib.ie → AIB) like a domain never seen before. Returns null unless
 * one client clearly wins.
 */
export function suggestClientId(
  attendees: Attendee[],
  history: { clientId: string; attendees: Attendee[] }[],
  clients: { id: string; name: string }[],
): string | null {
  const domains = new Set(
    attendees.map((a) => emailDomain(a.email)).filter((d): d is string => d !== null),
  );
  if (domains.size === 0) return null;

  // domain → clientId → number of meetings
  const counts = new Map<string, Map<string, number>>();
  for (const h of history) {
    const meetingDomains = new Set(
      h.attendees.map((a) => emailDomain(a.email)).filter((d): d is string => d !== null),
    );
    for (const d of meetingDomains) {
      const perClient = counts.get(d) ?? new Map<string, number>();
      perClient.set(h.clientId, (perClient.get(h.clientId) ?? 0) + 1);
      counts.set(d, perClient);
    }
  }

  const score = new Map<string, number>();
  const add = (id: string, v: number) => score.set(id, (score.get(id) ?? 0) + v);
  for (const d of domains) {
    const perClient = counts.get(d);
    const total = perClient ? [...perClient.values()].reduce((s, n) => s + n, 0) : 0;
    const ubiquitous = history.length >= 2 && total / history.length > 0.5;
    if (perClient && total > 0 && !ubiquitous) {
      for (const [id, n] of perClient) add(id, n / total);
      continue;
    }
    const label = normaliseName(companyFromDomain(d) ?? '');
    if (label.length < 3) continue;
    const matches = clients.filter((c) => {
      const name = normaliseName(c.name);
      return name.length >= 3 && (name.startsWith(label) || label.startsWith(name));
    });
    if (matches.length === 1) add(matches[0].id, 1);
  }

  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] < 0.5) return null;
  if (ranked.length > 1 && ranked[1][1] === ranked[0][1]) return null;
  return ranked[0][0];
}
