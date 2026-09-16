import type { Metadata } from "next";
import Link from "next/link";
import { listExamSeries, listSubjects, listYears, searchPublicArtifactsCached } from "@/lib/db/queries";
import { formatBytes, seriesDisplayLabel, verificationLabel, verificationTone } from "@/lib/format";
import { Badge } from "@/components/Badge";

export const metadata: Metadata = {
  title: "Search",
};

// This route reads searchParams (q/series/year/subject), which Next.js
// always renders per-request regardless of a `revalidate` export -- so
// unlike the other public pages, this one can't be page-level ISR'd. The
// underlying query is still cached at the data layer instead; see
// searchPublicArtifactsCached in src/lib/db/queries.ts.
export const dynamic = "force-dynamic";

interface ResultsPageProps {
  searchParams: Promise<{
    q?: string;
    series?: string;
    year?: string;
    subject?: string;
  }>;
}

export default async function ResultsPage({ searchParams }: ResultsPageProps) {
  const filters = await searchParams;
  const records = await searchPublicArtifactsCached(filters);
  const examSeries = await listExamSeries();
  const subjects = await listSubjects();
  const years = await listYears();
  const hasFilters = Boolean(
    filters.q || filters.series || filters.year || filters.subject
  );

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

      <p className="lede" style={{ margin: "1rem 0" }}>
        {hasFilters
          ? `${records.length} result${records.length === 1 ? "" : "s"}${filters.q ? ` for "${filters.q}"` : ""}.`
          : `Showing all ${records.length} published papers.`}
      </p>

      {records.length === 0 ? (
        <p className="empty-state">
          No published papers match those filters yet. Try clearing a filter
          or <Link href="/browse">browse what&apos;s available</Link>.
        </p>
      ) : (
        <div className="data-table table-scroll">
          <table>
            <caption className="visually-hidden">Matching exam papers</caption>
            <thead>
              <tr>
                <th scope="col">Year</th>
                <th scope="col">Subject</th>
                <th scope="col">Exam level</th>
                <th scope="col">Verification</th>
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
                    <td data-label="Verification">
                      <Badge tone={verificationTone(r.verification)}>{verificationLabel(r.verification)}</Badge>
                    </td>
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
      )}
    </>
  );
}
