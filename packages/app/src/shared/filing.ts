/**
 * "Queue all, file later": recordings queued without a client or meeting
 * type are classified by the pipeline and held at 'to_file' until the
 * user confirms where they go. See main/filingSuggestion.ts.
 */
export type FilingConfidence = 'low' | 'medium' | 'high';

export interface FileRecordingPayload {
  recordingId: string;
  clientId: string;
  meetingTypeId: string;
}

/**
 * The summary was written with the suggested meeting type's prompt.
 * Choosing a different type means the summary is in the wrong shape and
 * has to be regenerated (from the stored transcript — never re-transcribed);
 * changing only the client just changes where it's written.
 */
export function filingNeedsResummary(summarisedWithTypeId: string | null, chosenTypeId: string): boolean {
  return summarisedWithTypeId !== chosenTypeId;
}

export function assertFileRecordingPayload(p: unknown): FileRecordingPayload {
  if (!p || typeof p !== 'object') throw new Error('Filing payload must be an object');
  const v = p as Record<string, unknown>;
  for (const key of ['recordingId', 'clientId', 'meetingTypeId'] as const) {
    if (typeof v[key] !== 'string' || (v[key] as string).length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  return { recordingId: v.recordingId as string, clientId: v.clientId as string, meetingTypeId: v.meetingTypeId as string };
}

/**
 * Whether a "Queue all" recording can skip Ready to file. Opt-in
 * (config autoFileHighConfidence). Every condition must hold: the
 * classifier was highly confident, it named a real client, the calendar
 * (when it names an account) agrees, the chosen meeting type is still in
 * use, and there was meeting content. Anything else waits for the user —
 * a wrong auto-filed Apple Note can only be fixed by duplicating it.
 */
export interface AutoFileInput {
  confidence: string | null;
  suggestedClientId: string | null;
  /** The account the calendar points to, or null when it names none (or overlaps disagree). */
  calendarClientId: string | null;
  meetingTypeRetired: boolean;
  /** First line of the summary. */
  summaryTitle: string | null;
}

export function autoFileDecision(input: AutoFileInput): { file: boolean; reason: string } {
  if (input.confidence !== 'high') return { file: false, reason: 'classifier confidence was not high' };
  if (!input.suggestedClientId || input.suggestedClientId === 'unclassified') {
    return { file: false, reason: 'no client was identified' };
  }
  if (input.calendarClientId && input.calendarClientId !== input.suggestedClientId) {
    return { file: false, reason: 'the calendar points to a different account' };
  }
  if (input.meetingTypeRetired) return { file: false, reason: 'the chosen meeting type is retired' };
  if (input.summaryTitle?.trim().toLowerCase() === 'no meeting content recorded') {
    return { file: false, reason: 'the recording has no meeting content' };
  }
  return {
    file: true,
    reason: input.calendarClientId ? 'high confidence, confirmed by the calendar' : 'high confidence from the transcript',
  };
}
