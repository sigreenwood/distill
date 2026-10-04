/** Resolve native files once, keeping calendar PDFs out of the recording importer. */
export function resolveInboxDrop<T extends { name: string }>(
  files: readonly T[],
  getPath: (file: T) => string,
): { calendarPaths: string[]; recordingPaths: string[]; unresolvedNames: string[] } {
  const calendarPaths = new Set<string>();
  const recordingPaths = new Set<string>();
  const unresolvedNames: string[] = [];
  for (const file of files) {
    const path = getPath(file);
    if (!path) unresolvedNames.push(file.name);
    else if (/\.pdf$/i.test(path)) calendarPaths.add(path);
    else recordingPaths.add(path);
  }
  return { calendarPaths: [...calendarPaths], recordingPaths: [...recordingPaths], unresolvedNames };
}
