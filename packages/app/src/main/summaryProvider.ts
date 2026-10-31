/**
 * Who writes a recording's summary: local Ollama (the default, and the only
 * thing that ever happens unless the user has said otherwise) or Claude Code,
 * which sends the transcript to Anthropic.
 *
 * Deliberately a short, pure function of two things the user set, so each rule
 * can be tested and read: nothing goes to Claude unless the feature is on AND
 * this recording's client has been individually allowed. The reverse direction
 * has no rule at all — a failure on the local side never falls back to the
 * cloud (see pipelineSteps.doSummarise).
 */
export interface ClaudeSummarySettings {
  enabled: boolean;
  /** '' = Claude Code's default model. */
  model: string;
  /** Also use Claude for recordings not filed to any client. Off unless asked for. */
  forUnfiled: boolean;
}

export type SummaryProvider = 'ollama' | 'claude-code';

export interface ProviderChoice {
  provider: SummaryProvider;
  /** Logged, so "why did this stay local / go to Claude" is answerable. */
  reason: string;
}

/** The placeholder client for recordings with no real one. */
const UNCLASSIFIED = 'unclassified';

export function chooseSummaryProvider(input: {
  settings: ClaudeSummarySettings;
  client: { id: string; claude_summaries: number } | null;
}): ProviderChoice {
  const { settings, client } = input;
  if (!settings.enabled) return { provider: 'ollama', reason: 'Claude summaries are off' };
  if (client === null || client.id === UNCLASSIFIED) {
    return settings.forUnfiled
      ? { provider: 'claude-code', reason: 'not filed to a client, and Claude is allowed for those' }
      : { provider: 'ollama', reason: 'not filed to a client, and Claude is not allowed for those' };
  }
  return client.claude_summaries === 1
    ? { provider: 'claude-code', reason: 'this client is allowed to use Claude' }
    : { provider: 'ollama', reason: 'this client has not been allowed to use Claude' };
}

/** Model names go onto a command line, so only plain model identifiers are accepted. */
export function normaliseClaudeModel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const m = raw.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/.test(m) ? m : '';
}

/**
 * The client to judge a recording by. Only a CONFIRMED client (one the user
 * filed it under) can allow Claude. A client that is merely suggested — "Queue
 * all" rows are summarised before the user confirms — can only hold it back:
 * the suggestion comes from a local model and can be wrong, and a wrong guess
 * must never send a confidential client's transcript to the cloud.
 */
export function gateClientFor(
  row: { client_id: string | null; suggested_client_id: string | null },
  lookup: (id: string) => { id: string; claude_summaries: number } | undefined,
): { id: string; claude_summaries: number } | null {
  const confirmed = row.client_id ? lookup(row.client_id) : undefined;
  if (confirmed) return { id: confirmed.id, claude_summaries: confirmed.claude_summaries };
  const suggested = row.suggested_client_id ? lookup(row.suggested_client_id) : undefined;
  return suggested ? { id: suggested.id, claude_summaries: 0 } : null;
}
