import type { ExamContentAvailability } from "@/lib/db/queries";

/**
 * When someone browses the archive, we always show every year in this
 * whole range as an option, whether or not we've actually added any
 * papers for it yet. That's because papers get added gradually over time
 * — a year should still be there to click into (even if it shows as
 * empty) before anything has been added for it.
 */
export const BROWSE_YEAR_FROM = 2015;
export const BROWSE_YEAR_TO = 2025;

/** The fixed list of years shown when browsing, newest year first. */
export function listBrowseYears(): number[] {
  const years: number[] = [];
  for (let y = BROWSE_YEAR_TO; y >= BROWSE_YEAR_FROM; y--) years.push(y);
  return years;
}

/** True when an exam series has no publicly visible papers at all, for any year. */
export function seriesIsEmpty(seriesCode: string, availability: ExamContentAvailability): boolean {
  return !availability.seriesWithContent.has(seriesCode);
}

/**
 * Out of the given years, returns the ones that have no publicly visible
 * papers for this particular exam series. This is only worth showing on a
 * per-year basis when the whole series isn't already empty (see
 * seriesIsEmpty above) — that way, the "nothing here yet" message shows up
 * once for the whole series, instead of being repeated on every single
 * year.
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
