import type { ExamContentAvailability } from "@/lib/db/queries";

/**
 * The browse drill-down shows every exam level across this full range as a
 * placeholder, regardless of which years currently have ingested content --
 * papers are gathered incrementally, and the year should still be there to
 * navigate to (and show as empty) before anything's been added for it.
 */
export const BROWSE_YEAR_FROM = 2015;
export const BROWSE_YEAR_TO = 2025;

/** Fixed placeholder year range for the browse drill-down, newest first. */
export function listBrowseYears(): number[] {
  const years: number[] = [];
  for (let y = BROWSE_YEAR_TO; y >= BROWSE_YEAR_FROM; y--) years.push(y);
  return years;
}

/** True when an exam series has zero public content across every year. */
export function seriesIsEmpty(seriesCode: string, availability: ExamContentAvailability): boolean {
  return !availability.seriesWithContent.has(seriesCode);
}

/**
 * Years (within the given set) that have zero public content for one
 * series. Only meaningful to show per-row when the series itself isn't
 * already fully empty -- see seriesIsEmpty -- so the "no content" signal
 * rolls up to the series level instead of repeating on every year row.
 */
export function emptyYearsForSeries(
  seriesCode: string,
  years: number[],
  availability: ExamContentAvailability
): Set<number> {
  const empty = new Set<number>();
  for (const year of years) {
    if (!availability.yearsWithContent.has(`${seriesCode}:${year}`)) empty.add(year);
  }
  return empty;
}
