import type { Metadata } from "next";
import Link from "next/link";
import { listExamSeries, listSubjects, listYears, searchPublicArtifactsPageCached } from "@/lib/db/queries";
import { formatBytes, seriesDisplayLabel } from "@/lib/format";

export const metadata: Metadata = {
  title: "Search",
  description: "Search past Solomon Islands national exam papers by keyword, exam level, year, or subject.",
  // Filtered/query-string search results are near-duplicates of each other
  // and of /browse's own listings -- indexing them adds noise without
  // adding anything a crawler couldn't already find via the browse tree or
  // an individual paper's own page. Standard practice for a site search
  // results page (Google's own guidance recommends noindex here).
  robots: { index: false, follow: true },
};

// This route reads searchParams (q/series/year/subject/page/limit), which
// Next.js always renders per-request regardless of a `revalidate` export --
// so unlike the other public pages, this one can't be page-level ISR'd. The
// underlying query is still cached at the data layer instead; see
// searchPublicArtifactsPageCached in src/lib/db/queries.ts.
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

/** Builds a /results link preserving the current filters (and a custom
 * limit, if one was explicitly set) while switching to a different page. */
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

  // Three independent reads (the page's own paginated search, plus the
  // three filter dropdowns' option lists) run concurrently -- none depends
  // on another's result.
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
            <select id="series" name="series" defaultValue={filters.series ?? ""}>
              <option value="">Any exam level</option>
              {examSeries.map((s) => (
                <option key={s.code} value={s.code}>
                  {seriesDisplayLabel(s.code)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="year" className="visually-hidden">
              Year
            </label>
            <select id="year" name="year" defaultValue={filters.year ?? ""}>
              <option value="">Any year</option>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="subject" className="visually-hidden">
              Subject
            </label>
            <select id="subject" name="subject" defaultValue={filters.subject ?? ""}>
              <option value="">Any subject</option>
              {subjects.map((s) => (
                <option key={s.id} value={s.subjectCode ?? s.id}>
                  {s.canonicalName}
                </option>
              ))}
            </select>
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
        // total > 0 but this specific page has nothing -- a page number
        // past the last one (e.g. a stale/hand-edited ?page= link), not
        // "no matches", so it gets its own message rather than the one
        // above.
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
