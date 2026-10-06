/**
 * Actions and decisions read straight out of a finished summary, so a
 * meeting that produced follow-ups can be flagged and reviewed later
 * (the Follow-ups window). Layout rules, not a model: the summary is
 * already the model's output, and re-asking a model would only add a
 * second place for it to drift.
 *
 * Handles the current prompts ("## Actions" with "- [ ] Owner — action
 * — due", "**Teradata**"/"**Customer**" groups, the club minutes table,
 * "## Decisions" and inline "**Decisions and votes:**") and the shapes
 * older prompts left in the library ("✅ Name to …", "- **Action**: …"
 * with nested "Owner:"/"Timeframe:", "**Person:**" groups).
 */

export interface FollowUpItem {
  text: string;
  /** As written in the summary; null when none is named or it says "Owner unclear". */
  owner: string | null;
  /** As written ("14 November", "end of week"); never parsed into a date. */
  due: string | null;
  /** The side or group it was listed under, e.g. "Teradata" or "Customer". */
  group: string | null;
}

export interface FollowUps {
  actions: FollowUpItem[];
  decisions: FollowUpItem[];
}

type Kind = 'actions' | 'decisions';

const ACTION_HEADING = /\b(actions?|action items|follow[- ]?ups?|calls? to action|next steps|commitments)\b/i;
const DECISION_HEADING = /\bdecisions?\b/i;
/** Customer-workshop "Promised follow-up material" lists documents, not tasks. */
const NOT_ACTIONS = /\bmaterial\b/i;
const NOTHING = /^(none( agreed| recorded| stated)?|no (actions?|decisions?)( agreed| recorded)?|not stated|n\/a|-)\.?$/i;
const UNKNOWN_OWNER = /^(owner unclear|speaker unclear|\[?speaker unidentified\]?|unassigned|unknown|tbc|tbd|not stated)$/i;
const NOT_STATED = /^\(?not stated\)?\.?$/i;
/** The last "—" part is a due date only if it looks like one; otherwise it is the action itself. */
const DUE_HINT =
  /\d|\b(today|tomorrow|tonight|asap|immediate(ly)?|ongoing|end of|eod|eow|week|month|quarter|year|monday|tuesday|wednesday|thursday|friday|mon|tue|wed|thu|fri|jan(uary)?|feb(ruary)?|march|april|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/i;

function headingKind(title: string): Kind | null {
  if (ACTION_HEADING.test(title) && !NOT_ACTIONS.test(title)) return 'actions';
  if (DECISION_HEADING.test(title) && !/decision[- ]?makers?/i.test(title)) return 'decisions';
  return null;
}

function stripMarkup(text: string): string {
  return text
    .replace(/^\[[ xX]\]\s*/, '')
    .replace(/^✅\s*/, '')
    .replace(/\*\*|__/g, '')
    .replace(/^`|`$/g, '')
    .replace(/^action:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Owner — action — due" (the current prompts), "[Owner] action" and "Owner — **HSBC** — action" (older ones). */
function splitAction(raw: string, group: string | null): FollowUpItem {
  let text = stripMarkup(raw);
  let owner: string | null = null;
  let due: string | null = null;
  const bracketed = /^\[([^\]]{1,60})\]\s+(.*)$/.exec(text);
  if (bracketed) {
    owner = bracketed[1].trim();
    text = bracketed[2].trim().replace(/^to\s+/i, '');
  } else {
    const parts = text.split(/\s+[—–]\s+/);
    if (parts.length >= 3) {
      const last = parts[parts.length - 1];
      if (NOT_STATED.test(last)) parts.pop();
      else if (last.length <= 40 && DUE_HINT.test(last)) due = parts.pop()!.replace(/^due:?\s*/i, '');
    }
    if (parts.length >= 2 && parts[0].length <= 60 && parts[0].split(/\s+/).length <= 6) {
      owner = parts.shift()!;
    }
    text = parts.join(' — ');
    // "Akhil to follow up on …" (older prompts): a short capitalised name before "to".
    const named = owner ? null : /^([A-Z][\w'.&/-]*(?:\s+(?:and\s+)?[A-Z][\w'.&/-]*){0,3})\s+to\s+(\S.*)$/.exec(text);
    if (named) {
      owner = named[1];
      text = named[2];
    }
  }
  if (owner && UNKNOWN_OWNER.test(owner)) owner = null;
  return { text, owner, due, group };
}

interface Bullet {
  indent: number;
  text: string;
  children: string[];
}

function itemsFrom(kind: Kind, bullets: Bullet[], tableRows: string[][], groupOf: Map<Bullet, string | null>): FollowUpItem[] {
  const out: FollowUpItem[] = [];
  const push = (raw: string, group: string | null, extra: { owner?: string | null; due?: string | null } = {}) => {
    const cleaned = stripMarkup(raw);
    if (!cleaned || NOTHING.test(cleaned)) return;
    if (kind === 'decisions') {
      out.push({ text: cleaned, owner: null, due: null, group });
      return;
    }
    const item = splitAction(raw, group);
    if (extra.owner !== undefined && !item.owner) item.owner = extra.owner;
    if (extra.due !== undefined && !item.due) item.due = extra.due;
    if (item.text && !NOTHING.test(item.text)) out.push(item);
  };

  for (const b of bullets) {
    const group = groupOf.get(b) ?? null;
    const label = stripMarkup(b.text);
    // "**Kevin Sturgeon:**" / "**Promised Actions**" with nested bullets: a heading, not an item.
    if (b.children.length > 0 && /:$/.test(label)) {
      for (const child of b.children) push(child, label.replace(/:$/, ''));
      continue;
    }
    let owner: string | null | undefined;
    let due: string | null | undefined;
    for (const child of b.children) {
      const c = stripMarkup(child);
      const o = /^owners?:\s*(.+)$/i.exec(c);
      const d = /^(timeframe|due|deadline|by when):\s*(.+)$/i.exec(c);
      if (o) owner = o[1].trim();
      else if (d && !NOT_STATED.test(d[2].trim())) due = d[2].trim();
    }
    push(b.text, group, { owner, due });
  }

  if (tableRows.length > 1) {
    const header = tableRows[0].map((h) => h.toLowerCase());
    const col = (re: RegExp) => header.findIndex((h) => re.test(h));
    const textCol = col(kind === 'actions' ? /action|task/ : /decision/);
    const ownerCol = col(/owner|who/);
    const dueCol = col(/deadline|due|when|date/);
    for (const row of tableRows.slice(1)) {
      const text = textCol >= 0 ? row[textCol] ?? '' : row.filter((c) => c && !/^\d+$/.test(c)).join(' — ');
      const cleaned = stripMarkup(text);
      if (!cleaned || NOTHING.test(cleaned)) continue;
      const owner = ownerCol >= 0 ? stripMarkup(row[ownerCol] ?? '') : '';
      const due = dueCol >= 0 ? stripMarkup(row[dueCol] ?? '') : '';
      out.push({
        text: cleaned,
        owner: owner && !UNKNOWN_OWNER.test(owner) ? owner : null,
        due: due && !NOT_STATED.test(due) ? due : null,
        group: null,
      });
    }
  }
  return out;
}

export function extractFollowUps(summary: string | null | undefined): FollowUps {
  const result: FollowUps = { actions: [], decisions: [] };
  if (!summary?.trim()) return result;

  let kind: Kind | null = null;
  let level = 0;
  let group: string | null = null;
  let bullets: Bullet[] = [];
  let groupOf = new Map<Bullet, string | null>();
  let tableRows: string[][] = [];
  let baseIndent = Infinity;

  const flush = () => {
    if (kind) result[kind].push(...itemsFrom(kind, bullets, tableRows, groupOf));
    bullets = [];
    groupOf = new Map();
    tableRows = [];
    baseIndent = Infinity;
    group = null;
  };

  for (const rawLine of summary.split('\n')) {
    const line = rawLine.replace(/\t/g, '    ');
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const headingLevel = heading[1].length;
      const title = stripMarkup(heading[2].replace(/^[\d.]+\s*/, ''));
      if (kind && headingLevel > level) {
        // A subheading inside an Actions or Decisions section names a group ("### Teradata").
        group = title;
        continue;
      }
      flush();
      kind = headingKind(title);
      level = headingLevel;
      continue;
    }

    // Club minutes: "- **Decisions and votes:** Carried unanimously …" under each agenda item.
    const inline = /^\s*(?:[-*+]\s+)?\*\*decisions?(?: and votes)?:?\*\*:?\s*(.+)$/i.exec(line);
    if (inline && kind !== 'decisions') {
      const text = stripMarkup(inline[1]);
      if (text && !NOTHING.test(text) && !/^leave out/i.test(text)) {
        result.decisions.push({ text, owner: null, due: null, group: null });
      }
      continue;
    }
    if (!kind) continue;

    if (/^\s*\|/.test(line)) {
      if (/^\s*\|[\s:|-]+\|?\s*$/.test(line)) continue;
      tableRows.push(line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
      continue;
    }

    const bullet = /^(\s*)(?:[-*+•]|\d+[.)])\s+(.*\S)\s*$/.exec(line) ?? /^(\s*)(✅\s*.*\S)\s*$/.exec(line);
    if (bullet) {
      const indent = bullet[1].length;
      const parent = bullets[bullets.length - 1];
      if (parent && indent > baseIndent) {
        parent.children.push(bullet[2]);
      } else {
        baseIndent = Math.min(baseIndent, indent);
        const b: Bullet = { indent, text: bullet[2], children: [] };
        bullets.push(b);
        groupOf.set(b, group);
      }
      continue;
    }

    // "**Teradata**" on its own line groups the bullets after it.
    const label = /^\s*\*\*([^*]{1,60})\*\*:?\s*$/.exec(line);
    if (label) group = label[1].trim().replace(/:$/, '');
  }
  flush();
  return result;
}

/** How a meeting's follow-ups read in a list: "3 actions · 1 decision". */
export function followUpCountLabel(actions: number, decisions: number): string {
  const parts: string[] = [];
  if (actions) parts.push(`${actions} action${actions === 1 ? '' : 's'}`);
  if (decisions) parts.push(`${decisions} decision${decisions === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** What the Follow-ups window lists for one meeting. */
export interface MeetingFollowUps {
  recordingId: string;
  title: string;
  date: number;
  clientId: string | null;
  clientName: string | null;
  meetingTypeName: string | null;
  actions: FollowUpItem[];
  decisions: FollowUpItem[];
  /** Marked reviewed against the summary as it is now; a rewritten summary is flagged again. */
  reviewed: boolean;
}
