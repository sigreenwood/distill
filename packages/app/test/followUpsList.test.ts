import { describe, expect, it } from 'vitest';
import { isFollowUpsReviewed, listMeetingFollowUps, summaryHash } from '../src/main/followUpsList.js';
import type { JoinedRecordingRow } from '../src/main/state.js';

const SUMMARY = 'Upgrade plan agreed\n## Actions\n- [ ] Alex — Book the window — Friday\n## Decisions\n- Upgrade on 6 November.';

function row(over: Partial<JoinedRecordingRow>): JoinedRecordingRow {
  return {
    id: 'r1', filename: 'Weekly sync', start_time: 1_000, synced_at: 1_000, client_id: 'acme', client_name: 'Acme',
    meeting_type_name: 'Customer · Status call', summary_text: SUMMARY, follow_ups_reviewed_hash: null, status: 'complete',
    ...over,
  } as JoinedRecordingRow;
}

describe('listMeetingFollowUps', () => {
  it('lists meetings with actions or decisions and leaves out the rest', () => {
    const list = listMeetingFollowUps([row({}), row({ id: 'r2', summary_text: 'Chat\n## Actions\n- None agreed.' })]);
    expect(list.map((m) => m.recordingId)).toEqual(['r1']);
    expect(list[0]).toMatchObject({ clientName: 'Acme', reviewed: false });
    expect(list[0].actions[0]).toMatchObject({ owner: 'Alex', text: 'Book the window', due: 'Friday' });
    expect(list[0].decisions).toHaveLength(1);
  });

  it('filters by client, date and review', () => {
    const reviewed = row({ id: 'r2', follow_ups_reviewed_hash: summaryHash(SUMMARY) });
    const rows = [row({}), reviewed, row({ id: 'r3', client_id: 'other', start_time: 5_000 })];
    expect(listMeetingFollowUps(rows, { clientId: 'acme' }).map((m) => m.recordingId)).toEqual(['r1', 'r2']);
    expect(listMeetingFollowUps(rows, { sinceMs: 2_000 }).map((m) => m.recordingId)).toEqual(['r3']);
    expect(listMeetingFollowUps(rows, { unreviewedOnly: true }).map((m) => m.recordingId)).toEqual(['r1', 'r3']);
  });

  it('flags a meeting again when its summary is rewritten after review', () => {
    const r = row({ follow_ups_reviewed_hash: summaryHash(SUMMARY) });
    expect(isFollowUpsReviewed(r)).toBe(true);
    expect(isFollowUpsReviewed({ ...r, summary_text: `${SUMMARY}\n- Another decision.` })).toBe(false);
  });
});
