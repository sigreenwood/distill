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

/** null means every active prompt; an empty list deliberately offers none. */
export function meetingTypesForOrganisation<T extends { id: string; retired?: number | boolean }>(
  types: T[], organisation?: { meetingTypeIds?: string[] | null } | null,
): T[] {
  const allowed = organisation?.meetingTypeIds;
  return offeredMeetingTypes(types).filter(t => allowed == null || allowed.includes(t.id));
}

export function parseMeetingTypeIds(json: string | null | undefined): string[] | null {
  if (json == null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every(id => typeof id === 'string') ? value : [];
  } catch { return []; }
}

export function defaultMeetingTypeIds(name: string): string[] | null {
  return name.trim().toLowerCase() === 'ladffa' ? ['club-agm', 'club-committee'] : null;
}
