/**
 * A paper page's Previous / Next links: the nearest paper on each side of
 * the current one, in the subject's reading order (listSubjectArtifacts in
 * src/lib/db/queries.ts), that a student can actually open. "Not yet
 * recovered" placeholders in between are skipped, so Previous/Next never
 * lead to a page with nothing to open. A side with no such paper has no
 * link (undefined) -- nor does either side if the current paper isn't in
 * the list.
 *
 * Pure -- no database.
 */
export function adjacentOpenablePapers<T extends { id: string; openable: boolean }>(
  papers: readonly T[],
  currentId: string
): { prev?: T; next?: T } {
  const index = papers.findIndex((p) => p.id === currentId);
  if (index < 0) return {};
  return {
    prev: papers.slice(0, index).findLast((p) => p.openable),
    next: papers.slice(index + 1).find((p) => p.openable),
  };
}
