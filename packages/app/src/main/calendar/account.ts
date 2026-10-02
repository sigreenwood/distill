/**
 * Which account a calendar meeting belongs to, from the user's own client
 * names: no separate rules to maintain. Many account meetings are
 * internal-only ("HSBC Daily Huddle", "LBG: Daily stand up"), so the
 * subject carries most of the signal; external invitees' email domains
 * (hsbc.co.in, lloydsbanking.com, aib.ie) and the invite text back it up.
 */
import type { AccountSuggestion, CalendarMatch } from '../../shared/calendar.js';

const FILLER = new Set(['and', 'of', 'the', '&', 'plc', 'ltd', 'limited', 'group', 'bank', 'banking', 'inc']);

/**
 * "Lloyds Banking Group" → ["lloyds banking group", "lbg", "lloyds"];
 * "HSBC" → ["hsbc"]. The acronym covers how account teams abbreviate.
 */
export function clientKeywords(name: string): string[] {
  const words = name.toLowerCase().split(/[^a-z0-9&]+/).filter(Boolean);
  const out = new Set<string>([words.join(' ')]);
  if (words.length >= 2) out.add(words.filter((w) => w !== '&' && w !== 'and' && w !== 'of').map((w) => w[0]).join(''));
  const first = words[0];
  if (first && first.length >= 3 && !FILLER.has(first)) out.add(first);
  return [...out].filter((k) => k.length >= 2);
}

function mentions(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(text);
}

/** "jo@uk.hsbc.co.in" → ["uk", "hsbc"]: the labels a company name could be. */
function domainLabels(email: string): string[] {
  const host = email.split('@')[1] ?? '';
  return host.split('.').filter((l) => l.length >= 2 && !['com', 'co', 'org', 'net', 'ie', 'uk', 'in', 'hk', 'gov'].includes(l));
}

function domainMatches(email: string, keyword: string): boolean {
  if (keyword.includes(' ')) return false;
  return domainLabels(email).some((label) => label === keyword || (keyword.length >= 4 && label.startsWith(keyword)));
}

/**
 * Null when nothing points at a client, or two clients are equally
 * supported: a wrong account is worse than none, since the user is shown
 * this as a suggestion to accept.
 */
export function accountFor(
  match: Pick<CalendarMatch, 'subject' | 'attendees' | 'body'>,
  clients: { id: string; name: string }[],
): AccountSuggestion | null {
  const results: { clientId: string; score: number; reasons: string[] }[] = [];
  for (const client of clients) {
    if (client.id === 'unclassified') continue;
    const keywords = clientKeywords(client.name);
    let score = 0;
    const reasons: string[] = [];
    const inSubject = keywords.find((k) => mentions(match.subject, k));
    if (inSubject) {
      score += 3;
      reasons.push(`the meeting title mentions ${inSubject.toUpperCase().length <= 4 ? inSubject.toUpperCase() : client.name}`);
    }
    const domains = new Set(
      match.attendees
        .filter((a) => a.email && keywords.some((k) => domainMatches(a.email!, k)))
        .map((a) => a.email!.split('@')[1]),
    );
    if (domains.size > 0) {
      score += 2;
      reasons.push(`invitees from ${[...domains].slice(0, 3).join(', ')}`);
    }
    if (!inSubject && match.body && keywords.some((k) => mentions(match.body!, k))) {
      score += 1;
      reasons.push(`the invite mentions ${client.name}`);
    }
    if (score > 0) results.push({ clientId: client.id, score, reasons });
  }
  results.sort((a, b) => b.score - a.score);
  const [best, second] = results;
  if (!best || (second && second.score === best.score)) return null;
  return { clientId: best.clientId, reason: `From the calendar: ${best.reasons.join('; ')}.` };
}
