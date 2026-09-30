/**
 * Confirmed action/decision register: the persistent "status" the client
 * brief deliberately does not claim (see clientBrief.ts). Every item is
 * added by an explicit user action — from a brief point or a meeting —
 * and carries the single source meeting it came from.
 *
 * Actions have an open/done state the user sets; decisions have none —
 * a decision is a historical record, not something to complete. This
 * file holds the shared shape and the pure input validation both main
 * and the renderer need; see main/state.ts for storage.
 */

export type RegisterItemKind = 'action' | 'decision';
export type RegisterItemStatus = 'open' | 'done';

export const REGISTER_TEXT_MAX = 500;
export const REGISTER_OWNER_MAX = 100;

export interface RegisterItem {
  id: string;
  clientId: string;
  clientName: string;
  kind: RegisterItemKind;
  text: string;
  /** Action only. Left unknown (null) rather than guessed. */
  owner: string | null;
  /** Action only, epoch ms. Left unknown (null) rather than guessed. */
  dueAt: number | null;
  /** Set by the user; null for decisions, which have no open/done state. */
  status: RegisterItemStatus | null;
  sourceRecordingId: string;
  sourceTitle: string;
  sourceDate: number;
  createdAt: number;
  completedAt: number | null;
}

export interface RegisterAddInput {
  clientId: string;
  kind: RegisterItemKind;
  text: string;
  owner?: string | null;
  dueAt?: number | null;
  sourceRecordingId: string;
}

export interface RegisterAddCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * Validates a register-add request before it touches the database.
 * Deliberately strict about what can carry an owner/due date (actions
 * only) so a decision never grows a spurious open/done implication.
 */
export function checkRegisterAdd(input: RegisterAddInput): RegisterAddCheck {
  if (!input.clientId.trim()) return { ok: false, reason: 'Select a client.' };
  if (!input.sourceRecordingId.trim()) return { ok: false, reason: 'A source meeting is required.' };
  if (input.kind !== 'action' && input.kind !== 'decision') {
    return { ok: false, reason: 'Invalid kind.' };
  }
  const text = input.text.trim();
  if (!text) return { ok: false, reason: 'Enter what was decided or agreed.' };
  if (text.length > REGISTER_TEXT_MAX) {
    return { ok: false, reason: `Keep it under ${REGISTER_TEXT_MAX} characters.` };
  }
  if (input.owner && input.owner.trim().length > REGISTER_OWNER_MAX) {
    return { ok: false, reason: 'Owner name is too long.' };
  }
  if (input.dueAt != null && (!Number.isFinite(input.dueAt) || input.dueAt <= 0)) {
    return { ok: false, reason: 'Invalid due date.' };
  }
  return { ok: true, reason: null };
}

/** True only for an open action past its stated due date. Display only — never changes stored status. */
export function isOverdue(item: Pick<RegisterItem, 'kind' | 'status' | 'dueAt'>, now = Date.now()): boolean {
  return item.kind === 'action' && item.status === 'open' && item.dueAt != null && item.dueAt < now;
}
