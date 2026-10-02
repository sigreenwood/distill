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
