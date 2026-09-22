import type { CoverageCell } from "@/lib/db/queries";
import { artifactTypeLabel } from "@/lib/artifact-naming";

export interface MissingPaperRow {
  examSeriesCode: string;
  examSeriesName: string;
  year: number;
  subjectSlug: string;
  subjectName: string;
  // Human-readable type labels (e.g. ["Question paper", "Marking scheme"]),
  // already filtered to only the types genuinely relevant to this series --
  // see the big comment below.
  missingTypes: string[];
}

/**
 * Turns the coverage matrix into a public "help us find these" list.
 *
 * getCoverageMatrix()'s `byType` breakdown lists every artifact type a
 * SUBJECT has ever tracked, ANYWHERE across every series (see its own doc
 * comment) -- that's the right scope for the internal `coverage` report,
 * but wrong for a public list. Taken at face value it would claim, say,
 * "SIF3/SIJSC Accounting" is missing a question paper and a marking
 * scheme, when SIF3/SIJSC (Year 9) has never actually offered Accounting
 * at all -- that type only exists there because Accounting happens to be
 * a real SISC Level 2 subject. The same leak happens one level narrower
 * too: English's `listening_comprehension` type is only ever tracked for
 * SIF3/SIJSC, but without this filter it would also show up as "missing"
 * for SISC Level 1/2's English, which has never had that type at all.
 *
 * This function re-derives relevance itself, one level narrower than
 * `byType` does -- per (series, subject, type) triple instead of just per
 * subject -- using only the cells `getCoverageMatrix()` already returned
 * (no extra database query): a type only counts as a real gap if that
 * exact series has tracked it as non-missing somewhere, in any year.
 */
export function deriveMissingPaperRows(cells: CoverageCell[]): MissingPaperRow[] {
  const relevantType = new Set<string>();
  for (const cell of cells) {
    for (const entry of cell.byType) {
      if (entry.status !== "missing") {
        relevantType.add(`${cell.examSeriesCode}:${cell.subjectSlug}:${entry.type}`);
      }
    }
  }

  const rows: MissingPaperRow[] = [];
  for (const cell of cells) {
    const missing = cell.byType.filter(
      (entry) =>
        (entry.status === "missing" || entry.status === "not_yet_recovered") &&
        relevantType.has(`${cell.examSeriesCode}:${cell.subjectSlug}:${entry.type}`)
    );
    if (missing.length === 0) continue;
    rows.push({
      examSeriesCode: cell.examSeriesCode,
      examSeriesName: cell.examSeriesName,
      year: cell.year,
      subjectSlug: cell.subjectSlug,
      subjectName: cell.subjectName,
      missingTypes: missing.map((entry) => artifactTypeLabel(entry.type)),
    });
  }

  rows.sort((a, b) => {
    if (a.examSeriesCode !== b.examSeriesCode) return a.examSeriesCode.localeCompare(b.examSeriesCode);
    if (a.year !== b.year) return a.year - b.year;
    return a.subjectName.localeCompare(b.subjectName);
  });
  return rows;
}
