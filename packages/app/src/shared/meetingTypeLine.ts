/**
 * How a meeting type is described to the classifiers (the tag sheet's
 * meeting-type suggestion and the Queue all filing classifier): its name
 * and its "when to use" description. Only a type with no description
 * falls back to the opening of its prompt — older prompts open with
 * boilerplate ("You are an expert…") that says nothing about when to use
 * them, which is why descriptions exist (migration 19).
 */
const EXCERPT_CHARS = 200;

export function describeMeetingType(t: { name: string; prompt: string; description?: string | null }): string {
  const description = t.description?.trim();
  if (description) return `${t.name} — use for: ${description.replace(/\s+/g, ' ')}`;
  return `${t.name} — ${t.prompt.trim().slice(0, EXCERPT_CHARS).replace(/\s+/g, ' ')}`;
}

/** Types the classifiers and pickers may offer: everything not retired. */
export function offeredMeetingTypes<T extends { retired?: number | boolean }>(types: T[]): T[] {
  return types.filter((t) => !t.retired);
}
