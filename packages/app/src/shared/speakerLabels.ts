// Pure, so the renderer-shared summary builder can use it (callTracks.ts needs Node's fs).

/** True when the transcript came from a two-track call (see transcribe.py). */
export function hasSpeakerLabels(text: string): boolean {
  return /^(?:You|Others): /.test(text);
}

/**
 * Prepended to the transcript for the summariser (in the user message, not the
 * system prompt — those are hash-tracked, see doSummarise). Without it a model
 * reads "Others" as a person's name, or invents who the remote speakers were.
 */
export function speakerLegend(text: string): string | null {
  if (!hasSpeakerLabels(text)) return null;
  return (
    'Speaker labels in the transcript below: "You" is the person who recorded this call. ' +
    '"Others" is every other participant combined — the remote speakers are not told apart, ' +
    'so do not attribute an "Others" line to a specific person unless the words themselves say who it is.'
  );
}
