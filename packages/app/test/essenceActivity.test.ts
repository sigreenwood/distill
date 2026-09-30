import { describe, expect, it } from 'vitest';
import { resolveEssenceActivity, signalsFromInbox, type EssenceSignals } from '../src/renderer/essence/activity.js';
import type { InboxItemDTO } from '../src/renderer/shared/api.js';

const row = (status: InboxItemDTO['status'], id = status) => ({ id, status } as InboxItemDTO);
const signals = (patch: Partial<EssenceSignals> = {}): EssenceSignals => ({
  needsAttention: false,
  phase: null,
  waitingCount: 0,
  completedAt: null,
  ...patch,
});

describe('resolveEssenceActivity precedence', () => {
  it('an actionable error always wins, even mid-phase or during a completion pulse', () => {
    expect(resolveEssenceActivity(signals({ needsAttention: true, phase: 'transcribing' }))).toBe('error');
    expect(resolveEssenceActivity(signals({ needsAttention: true, completedAt: Date.now() }))).toBe('error');
  });

  it('maps the running phase to its own colour, grouping writing under summarising', () => {
    expect(resolveEssenceActivity(signals({ phase: 'downloading' }))).toBe('downloading');
    expect(resolveEssenceActivity(signals({ phase: 'transcribing' }))).toBe('transcribing');
    expect(resolveEssenceActivity(signals({ phase: 'summarising' }))).toBe('summarising');
    expect(resolveEssenceActivity(signals({ phase: 'writing' }))).toBe('summarising');
  });

  it('shows a recent completion only inside its TTL, then falls through to waiting/idle', () => {
    const now = 10_000;
    expect(resolveEssenceActivity(signals({ completedAt: now - 100 }), now)).toBe('complete');
    expect(resolveEssenceActivity(signals({ completedAt: now - 1800 }), now)).toBe('idle');
    expect(resolveEssenceActivity(signals({ completedAt: now - 2000, waitingCount: 3 }), now)).toBe('waiting');
  });

  it('falls back to waiting when nothing is running and something needs tagging, else idle', () => {
    expect(resolveEssenceActivity(signals({ waitingCount: 1 }))).toBe('waiting');
    expect(resolveEssenceActivity(signals())).toBe('idle');
  });
});

describe('signalsFromInbox', () => {
  it('picks up an error, the active phase, and the waiting count independently', () => {
    const recordings = [row('complete'), row('error'), row('transcribing'), row('inbox', 'a'), row('inbox', 'b')];
    expect(signalsFromInbox(recordings, null)).toEqual({
      needsAttention: true,
      phase: 'transcribing',
      waitingCount: 2,
      completedAt: null,
    });
  });

  it('reports no active phase and no attention when nothing is running or errored', () => {
    expect(signalsFromInbox([row('complete'), row('tagged')], null).phase).toBeNull();
    expect(signalsFromInbox([row('complete')], null).needsAttention).toBe(false);
  });

  it('threads completedAt through unchanged — it is derived by the caller, not this function', () => {
    expect(signalsFromInbox([], 12345).completedAt).toBe(12345);
  });
});
