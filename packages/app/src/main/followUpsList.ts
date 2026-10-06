/**
 * Meetings whose summaries recorded actions or decisions, for the
 * Follow-ups window and the inbox row's count. Read from the summary
 * text each time (shared/followUps.ts) — a few hundred summaries parse in
 * milliseconds — so nothing can go stale when a summary is rewritten.
 */
import crypto from 'node:crypto';
import { extractFollowUps, type MeetingFollowUps } from '../shared/followUps.js';
import type { JoinedRecordingRow } from './state.js';

export function summaryHash(summary: string): string {
  return crypto.createHash('sha1').update(summary).digest('hex');
}

export function isFollowUpsReviewed(row: Pick<JoinedRecordingRow, 'summary_text' | 'follow_ups_reviewed_hash'>): boolean {
  return Boolean(row.summary_text && row.follow_ups_reviewed_hash === summaryHash(row.summary_text));
}

export interface FollowUpsFilter {
  clientId?: string | null;
  /** Meetings on or after this time (epoch ms); omit for all time. */
  sinceMs?: number | null;
  /** Leave out meetings already marked reviewed. */
  unreviewedOnly?: boolean;
}

/** `rows` newest first, as State.listSummarisedJoined returns them. */
export function listMeetingFollowUps(rows: JoinedRecordingRow[], filter: FollowUpsFilter = {}): MeetingFollowUps[] {
  const out: MeetingFollowUps[] = [];
  for (const row of rows) {
    if (!row.summary_text) continue;
    const date = row.start_time ?? row.synced_at;
    if (filter.clientId && row.client_id !== filter.clientId) continue;
    if (filter.sinceMs != null && date < filter.sinceMs) continue;
    const reviewed = isFollowUpsReviewed(row);
    if (filter.unreviewedOnly && reviewed) continue;
    const { actions, decisions } = extractFollowUps(row.summary_text);
    if (actions.length === 0 && decisions.length === 0) continue;
    out.push({
      recordingId: row.id,
      title: row.filename,
      date,
      clientId: row.client_id,
      clientName: row.client_name,
      meetingTypeName: row.meeting_type_name,
      actions,
      decisions,
      reviewed,
    });
  }
  return out;
}
