/**
 * Versioned re-summarisation: try a different model or meeting-type
 * prompt against a transcript already summarised once, without
 * re-transcribing and without touching the live summary until the user
 * explicitly keeps a version. See shared/summaryVersion.ts for the DTO
 * shape and main/state.ts for storage (`summary_versions`).
 *
 * Deliberately separate from the normal pipeline's doSummarise, which
 * calls State.addSummaryVersion(..., active: true) itself on every
 * completion — this module only ever adds a candidate (active: false);
 * promoting one to "the" summary is State.activateSummaryVersion, driven
 * from the reader, not from here.
 */
import { OllamaClient } from './ollama.js';
import type { OllamaConfig } from './config.js';
import { assertLocalInference } from './localInference.js';
import { estimateTokenBudget, computeAdaptiveContextWindow } from './tokenBudget.js';
import { buildSummaryUserContent } from '../shared/summaryInput.js';
import type { SummaryVersionRow } from './state.js';
import type { SummaryVersionDTO } from '../shared/summaryVersion.js';

export interface GenerateVersionInput {
  transcriptText: string;
  attendeesJson: string | null;
  /** The recording's client and its account context, if any (shared/summaryInput.ts). */
  account?: { clientName: string; context: string | null } | null;
  meetingType: { name: string; prompt: string };
  model: string;
}

export interface GeneratedVersion {
  summaryText: string;
  model: string;
  warning: string | null;
}

export async function generateSummaryVersion(
  input: GenerateVersionInput,
  config: OllamaConfig,
  signal: AbortSignal,
): Promise<GeneratedVersion> {
  assertLocalInference({ ...config, model: input.model }, 'Generating an alternative summary');
  const userContent = buildSummaryUserContent({
    transcript: input.transcriptText,
    attendeesJson: input.attendeesJson,
    account: input.account,
  });
  const budget = estimateTokenBudget(input.meetingType.prompt, userContent, config.contextWindow);
  const numCtx = config.adaptiveContextWindow
    ? computeAdaptiveContextWindow(budget.estimatedInputTokens, config.contextWindow)
    : config.contextWindow;

  const response = await new OllamaClient(config.host).chat(
    {
      model: input.model,
      messages: [
        { role: 'system', content: input.meetingType.prompt },
        { role: 'user', content: userContent },
      ],
      think: false,
      keep_alive: config.keepAlive,
      options: { num_ctx: numCtx, temperature: config.temperature },
    },
    signal,
  );
  const summaryText = response.message.content.trim();
  if (!summaryText) throw new Error('Ollama returned an empty summary.');
  return {
    summaryText,
    model: response.model,
    warning: budget.exceedsBudget
      ? 'This transcript is large enough that Ollama may have truncated the start of it before summarising.'
      : null,
  };
}

/**
 * Reconciles the recording's live summary with its logged history. Every
 * summary produced after this feature shipped has a matching `is_active`
 * row from State.addSummaryVersion; a recording summarised before the
 * feature existed has none, so its current summary is synthesised as a
 * "Current" entry here rather than backfilled into the database — the
 * same read-time-reconciliation-over-backfill choice this codebase
 * already made for `original_prompt_hash` (see BACKLOG.md).
 */
export function buildVersionList(
  row: {
    summary_text: string | null;
    model_snapshot: string | null;
    meeting_type_name: string | null;
    updated_at: number;
  },
  historical: SummaryVersionRow[],
): SummaryVersionDTO[] {
  const versions: SummaryVersionDTO[] = [...historical]
    .sort((a, b) => b.created_at - a.created_at)
    .map((v) => ({
      id: v.id,
      summaryText: v.summary_text,
      model: v.model,
      meetingTypeName: v.meeting_type_name,
      isActive: v.is_active === 1,
      createdAt: v.created_at,
    }));
  const activeMatchesCurrent = versions.some((v) => v.isActive && v.summaryText === row.summary_text);
  if (row.summary_text && !activeMatchesCurrent) {
    for (const v of versions) v.isActive = false;
    versions.unshift({
      id: 'current',
      summaryText: row.summary_text,
      model: row.model_snapshot ?? 'unknown model',
      meetingTypeName: row.meeting_type_name ?? 'Current',
      isActive: true,
      createdAt: row.updated_at,
    });
  }
  return versions;
}
