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
