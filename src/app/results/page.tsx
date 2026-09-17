import type { Metadata } from "next";
import Link from "next/link";
import { listExamSeries, listSubjects, listYears, searchPublicArtifactsPageCached } from "@/lib/db/queries";
import { formatBytes, seriesDisplayLabel } from "@/lib/format";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";

export const metadata: Metadata = {
  title: "Search",
  description: "Search past Solomon Islands national exam papers by keyword, exam level, year, or subject.",
  // We ask search engines not to index this search-results page.
  // Filtered/keyword search results are near-duplicates of each other and
  // of the browse pages' own listings, so indexing them would just add
  // noise, without surfacing anything a search engine couldn't already
  // find through the browse pages or an individual paper's own page.
  // This matches standard advice for site-search results pages in general.
  robots: { index: false, follow: true },
};

// This page reads its filters straight out of the page's own URL (the
// search text, exam level, year, subject, page number). Next.js always
// treats a page like that as needing to render fresh every time — it
// can't use the simple whole-page caching that other public pages use.
// Instead, the caching happens one level down, on the database query
// itself; see searchPublicArtifactsPageCached in src/lib/db/queries.ts.
export const dynamic = "force-dynamic";

interface ResultsPageProps {
  searchParams: Promise<{
    q?: string;
    series?: string;
    year?: string;
    subject?: string;
    page?: string;
    limit?: string;
  }>;
}

/**
 * Builds a link to the search results page that keeps the current filters
 * (and any custom page size that was explicitly set) while switching to a
 * different page number.
 */
function buildPageHref(
  filters: { q?: string; series?: string; year?: string; subject?: string; limit?: string },
  page: number
): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.series) params.set("series", filters.series);
  if (filters.year) params.set("year", filters.year);
  if (filters.subject) params.set("subject", filters.subject);
  if (filters.limit) params.set("limit", filters.limit);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `/results?${qs}` : "/results";
}

export default async function ResultsPage({ searchParams }: ResultsPageProps) {
  const filters = await searchParams;
  const pageParam = filters.page ? Number(filters.page) : undefined;
  const limitParam = filters.limit ? Number(filters.limit) : undefined;

  // These don't depend on each other (the page's own search results, plus
  // the option lists for the three filter dropdowns), so we fetch them
  // all at once instead of one after another.
  const [{ records, total, page, limit, totalPages }, examSeries, subjects, years] = await Promise.all([
    searchPublicArtifactsPageCached(filters, { page: pageParam, limit: limitParam }),
    listExamSeries(),
    listSubjects(),
    listYears(),
  ]);

  const hasFilters = Boolean(filters.q || filters.series || filters.year || filters.subject);
  const rangeStart = total === 0 ? 0 : (page - 1) * limit + 1;
  const rangeEnd = Math.min(page * limit, total);

  return (
    <>
      <h1 className="visually-hidden">Search papers</h1>

      <form
        method="get"
        action="/results"
        aria-label="Search the archive"
        className="search-form search-form--inline"
      >
        <div className="search-form__row field">
          <div style={{ flex: "1 1 auto" }}>
            <label htmlFor="q" className="visually-hidden">
              Search
            </label>
            <input type="search" id="q" name="q" defaultValue={filters.q ?? ""} placeholder="Search papers" />
          </div>
          <button type="submit">Search</button>
        </div>

        <div className="search-form__filters field">
          <div>
            <label htmlFor="series" className="visually-hidden">
              Exam level
            </label>
            <AutoSubmitSelect id="series" name="series" defaultValue={filters.series ?? ""}>
              <option value="">Any exam level</option>
              {examSeries.map((s) => (
                <option key={s.code} value={s.code}>
                  {seriesDisplayLabel(s.code)}
                </option>
              ))}
            </AutoSubmitSelect>
          </div>
          <div>
            <label htmlFor="year" className="visually-hidden">
              Year
            </label>
            <AutoSubmitSelect id="year" name="year" defaultValue={filters.year ?? ""}>
              <option value="">Any year</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </AutoSubmitSelect>
          </div>
          <div>
            <label htmlFor="subject" className="visually-hidden">
              Subject
            </label>
            <AutoSubmitSelect id="subject" name="subject" defaultValue={filters.subject ?? ""}>
              <option value="">Any subject</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.subjectCode ?? s.id}>
                  {s.canonicalName}
                </option>
              ))}
            </AutoSubmitSelect>
          </div>
        </div>
      </form>

      {total > 0 && (
        <p className="lede" style={{ margin: "1rem 0" }}>
          {hasFilters
            ? `Showing ${rangeStart}–${rangeEnd} of ${total} result${total === 1 ? "" : "s"}${filters.q ? ` for "${filters.q}"` : ""}.`
            : `Showing ${rangeStart}–${rangeEnd} of ${total} published papers.`}
        </p>
      )}

      {total === 0 ? (
        <p className="empty-state">
          No published papers match those filters yet. Try clearing a filter
          or <Link href="/browse">browse what&apos;s available</Link>.
        </p>
      ) : records.length === 0 ? (
        // There ARE matching results overall, but this specific page has
        // none — meaning someone requested a page number past the last
        // real page (e.g. an old bookmarked or hand-typed "?page=" link).
        // That's different from "no matches at all", so it gets its own,
        // more specific message.
        <p className="empty-state">
          That page doesn&apos;t exist.{" "}
          <Link href={buildPageHref(filters, 1)}>Go to the first page</Link>.
        </p>
      ) : (
        <>
          <div className="data-table table-scroll">
            <table>
              <caption className="visually-hidden">Matching exam papers</caption>
              <thead>
                <tr>
                  <th scope="col">Year</th>
                  <th scope="col">Subject</th>
                  <th scope="col">Exam level</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => {
                  const href = `/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`;
                  return (
                    <tr key={r.id}>
                      <td data-label="Year">{r.year}</td>
                      <td data-label="Subject">{r.subject}</td>
                      <td data-label="Exam level">{seriesDisplayLabel(r.examSeriesCode)}</td>
                      <td>
                        <Link href={href}>View</Link>
                        {r.file && (
                          <>
                            {" · "}
                            <a href={`/api/files/${r.file.id}?dl=1`}>Download ({formatBytes(r.file.bytes)})</a>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <nav aria-label="Pagination" className="form-actions" style={{ justifyContent: "space-between", alignItems: "center" }}>
              {page > 1 ? (
                <Link href={buildPageHref(filters, page - 1)} className="button secondary">
                  ‹ Previous
                </Link>
              ) : (
                <span />
              )}
              <span className="hint">
                Page {page} of {totalPages}
              </span>
              {page < totalPages ? (
                <Link href={buildPageHref(filters, page + 1)} className="button secondary">
                  Next ›
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </>
  );
}
