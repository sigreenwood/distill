/** A meeting type offered in Settings → Prompts; see main/promptSuggestions.ts. */
export interface PromptSuggestion {
  id: string;
  name: string;
  /** When this meeting type fits, in one line. */
  useFor: string;
  prompt: string;
}
