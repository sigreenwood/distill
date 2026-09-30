import { useEffect, useRef, useState } from 'react';
import type { InboxItemDTO } from '../shared/api.js';
import { COMPLETION_TTL_MS, resolveEssenceActivity, signalsFromInbox } from './activity.js';
import type { EssenceActivity } from './tokens.js';

/**
 * Watches the inbox's own recordings list for a row transitioning into
 * 'complete' and turns that into a 1.8s completion pulse, then resolves
 * the overall Essence activity. `previousStatuses` only flags a
 * transition when the row was already known with a different status —
 * rows present on the very first load are never treated as "just
 * completed", so opening the window doesn't fire a false pulse.
 */
export function useEssenceActivity(recordings: InboxItemDTO[]): {
  activity: EssenceActivity;
  completionKey: string;
} {
  const previousStatuses = useRef<Map<string, InboxItemDTO['status']>>(new Map());
  const [completion, setCompletion] = useState<{ id: string; at: number } | null>(null);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const previous = previousStatuses.current;
    const justCompleted = recordings.find(
      (r) => r.status === 'complete' && previous.has(r.id) && previous.get(r.id) !== 'complete',
    );
    if (justCompleted) setCompletion({ id: justCompleted.id, at: Date.now() });
    previousStatuses.current = new Map(recordings.map((r) => [r.id, r.status]));
  }, [recordings]);

  useEffect(() => {
    if (!completion) return;
    const remaining = completion.at + COMPLETION_TTL_MS - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => forceTick((t) => t + 1), remaining + 20);
    return () => clearTimeout(timer);
  }, [completion]);

  const signals = signalsFromInbox(recordings, completion?.at ?? null);
  return { activity: resolveEssenceActivity(signals), completionKey: completion?.id ?? '' };
}
