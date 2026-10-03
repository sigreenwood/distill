/** A meeting type offered in Settings → Prompts; see main/promptSuggestions.ts. */
export interface PromptSuggestion {
  id: string;
  name: string;
  /** When this meeting type fits, in one line. */
  useFor: string;
  prompt: string;
}

/**
 * A suggestion as Settings shows it: a new meeting type to add, or a newer
 * shipped version (name, description, prompt) of one already added. `key`
 * is what dismissing records, so dismissing an update hides that version
 * only and a later revision is offered again.
 */
export interface SuggestionView extends PromptSuggestion {
  kind: 'new' | 'update';
  key: string;
  /** For an update: the name it has now. */
  currentName?: string;
}
