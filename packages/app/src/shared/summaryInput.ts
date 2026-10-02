/**
 * The user message for a summary request: account context (if the client
 * has one), the attendee roster (if any), then the transcript. Shared by
 * the pipeline (doSummarise) and the reader's alternative summaries
 * (summaryVersions.ts) so both see exactly the same input. The meeting
 * type's prompt stays the system message, untouched — it is hash-tracked.
 */
import { buildAttendeeRoster, parseStoredAttendees } from './attendees.js';

/** An account context is a brief, not a dossier: it rides along with every summary for that client. */
export const MAX_ACCOUNT_CONTEXT_CHARS = 3000;

export function buildAccountContext(clientName: string, context: string | null | undefined): string {
  const text = (context ?? '').trim().slice(0, MAX_ACCOUNT_CONTEXT_CHARS);
  if (!text) return '';
  return (
    `Account context for ${clientName} (the user's own background notes on this client, not part of the ` +
    'meeting: use them only to spell names and understand programmes and terms, and never report anything ' +
    'from them as said or decided in the meeting):\n' +
    text
  );
}

export function buildSummaryUserContent(input: {
  transcript: string;
  attendeesJson: string | null;
  account?: { clientName: string; context: string | null } | null;
}): string {
  const parts = [
    input.account ? buildAccountContext(input.account.clientName, input.account.context) : '',
    buildAttendeeRoster(parseStoredAttendees(input.attendeesJson)),
    input.transcript,
  ];
  return parts.filter(Boolean).join('\n\n');
}
