/**
 * Client preparation brief: shared types and the pure pieces the window
 * and the main process both need (selection limits, Markdown export).
 */

/** Most meetings one brief may draw on. */
export const BRIEF_MAX_MEETINGS = 8;
/**
 * Most summary text one brief may send to the model. Summaries only —
 * never transcripts. ~12k tokens at 4 chars/token: enough for eight
 * typical summaries, and a size a local 27B model gets through in
 * minutes rather than tens of minutes.
 */
export const BRIEF_MAX_SUMMARY_CHARS = 48_000;

export interface BriefCandidate {
  id: string;
  title: string;
  date: number;
  meetingType: string | null;
  /** Length of the summary available to the brief; 0 when there is none. */
  summaryChars: number;
}

/** A meeting as cited in a brief: `ref` is the label the model used. */
export interface BriefSource {
  ref: string;
  id: string;
  title: string;
  date: number;
}

export interface BriefItem {
  text: string;
  /** Refs of the meetings the point comes from, e.g. ["M2"]. */
  sources: string[];
}

export interface BriefCommitment extends BriefItem {
  owner: string | null;
}

export interface ClientBrief {
  clientName: string;
  /** Stated in the meetings. */
  decisions: BriefItem[];
  commitments: BriefCommitment[];
  openQuestions: BriefItem[];
  /** The model's inference, not a statement from any meeting. */
  suggestedQuestions: BriefItem[];
  sources: BriefSource[];
  /** Points the model returned without a valid source — not shown. */
  dropped: number;
  model: string;
  /** Set once saved (every generated brief is). */
  id?: string;
  savedAt?: number;
}

/** A saved brief as listed, before it is opened. */
export interface SavedBriefSummary {
  id: string;
  savedAt: number;
  model: string;
  meetings: number;
  /** Date range of the meetings it drew on. */
  from: number | null;
  to: number | null;
  points: number;
}

export function savedBriefSummary(brief: ClientBrief, id: string, savedAt: number): SavedBriefSummary {
  const dates = brief.sources.map((s) => s.date);
  return {
    id,
    savedAt,
    model: brief.model,
    meetings: brief.sources.length,
    from: dates.length ? Math.min(...dates) : null,
    to: dates.length ? Math.max(...dates) : null,
    points:
      brief.decisions.length + brief.commitments.length + brief.openQuestions.length + brief.suggestedQuestions.length,
  };
}

/** Null when the stored JSON is not a brief this version can show. */
export function parseSavedBrief(json: string): ClientBrief | null {
  try {
    const v = JSON.parse(json) as ClientBrief;
    const lists = [v.decisions, v.commitments, v.openQuestions, v.suggestedQuestions, v.sources];
    if (typeof v.clientName !== 'string' || typeof v.model !== 'string' || !lists.every(Array.isArray)) return null;
    return { ...v, dropped: typeof v.dropped === 'number' ? v.dropped : 0 };
  } catch {
    return null;
  }
}

export interface BriefSelectionCheck {
  ok: boolean;
  chars: number;
  reason: string | null;
}

export function checkBriefSelection(selected: BriefCandidate[]): BriefSelectionCheck {
  const chars = selected.reduce((sum, m) => sum + m.summaryChars, 0);
  if (selected.length === 0) return { ok: false, chars, reason: 'Select at least one meeting.' };
  if (selected.some((m) => m.summaryChars === 0)) {
    return { ok: false, chars, reason: 'A selected meeting has no summary.' };
  }
  if (selected.length > BRIEF_MAX_MEETINGS) {
    return { ok: false, chars, reason: `Select at most ${BRIEF_MAX_MEETINGS} meetings.` };
  }
  if (chars > BRIEF_MAX_SUMMARY_CHARS) {
    return { ok: false, chars, reason: 'Too much summary text — deselect a meeting or two.' };
  }
  return { ok: true, chars, reason: null };
}

/**
 * Newest meetings with a summary, as many as fit the limits. `candidates`
 * is newest first.
 */
export function defaultBriefSelection(candidates: BriefCandidate[], max = 5): string[] {
  const picked: string[] = [];
  let chars = 0;
  for (const m of candidates) {
    if (picked.length >= Math.min(max, BRIEF_MAX_MEETINGS)) break;
    if (m.summaryChars === 0 || chars + m.summaryChars > BRIEF_MAX_SUMMARY_CHARS) continue;
    picked.push(m.id);
    chars += m.summaryChars;
  }
  return picked;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "M2 · 2026-09-12" — how a citation reads outside the app. */
export function citationLabel(ref: string, sources: BriefSource[]): string {
  const s = sources.find((x) => x.ref === ref);
  return s ? `${ref} · ${isoDate(s.date)}` : ref;
}

export function briefToMarkdown(brief: ClientBrief): string {
  const cite = (item: BriefItem) =>
    ` (${item.sources.map((r) => citationLabel(r, brief.sources)).join('; ')})`;
  const section = (title: string, items: BriefItem[], render: (i: BriefItem) => string) =>
    items.length ? [`## ${title}`, '', ...items.map(render), ''] : [];
  return [
    `# ${brief.clientName} — preparation brief`,
    '',
    `Drawn from ${brief.sources.length} meeting summar${brief.sources.length === 1 ? 'y' : 'ies'} by ${brief.model}, on this Mac${brief.savedAt ? `, ${isoDate(brief.savedAt)}` : ''}. Check points against the sources before relying on them.`,
    '',
    ...section('Decisions', brief.decisions, (i) => `- ${i.text}${cite(i)}`),
    ...section('Commitments made (status not tracked)', brief.commitments, (i) => {
      const owner = (i as BriefCommitment).owner;
      return `- ${owner ? `**${owner}:** ` : ''}${i.text}${cite(i)}`;
    }),
    ...section('Questions raised', brief.openQuestions, (i) => `- ${i.text}${cite(i)}`),
    ...section('Suggested questions (inferred, not stated)', brief.suggestedQuestions, (i) => `- ${i.text}${cite(i)}`),
    '## Sources',
    '',
    ...brief.sources.map((s) => `- ${s.ref}: ${s.title} (${isoDate(s.date)})`),
    '',
  ].join('\n');
}
