/**
 * The page addresses that include a subject, built in one place so every
 * page links to them the same way (and src/lib/db/queries.test.ts can check
 * them). The subject part always comes from SUBJECT_SLUG in
 * src/lib/db/visibility.ts, which is never empty or null.
 */

/** A browse-subject page, e.g. "/browse/sisc-l1/2019/mathematics". */
export function browseSubjectPath(examSeriesCode: string, year: number, subjectSlug: string): string {
  return `/browse/${examSeriesCode}/${year}/${subjectSlug}`;
}

/** A paper's page, e.g. "/exams/sisc-l1/2019/mathematics/paper-1". */
export function paperPath(paper: { examSeriesCode: string; year: number; subjectSlug: string; slug: string }): string {
  return `/exams/${paper.examSeriesCode}/${paper.year}/${paper.subjectSlug}/${paper.slug}`;
}
