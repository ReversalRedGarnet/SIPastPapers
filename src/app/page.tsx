import Link from "next/link";
import { listExamSeries, listRecentPublicArtifacts, listSubjects, listYears } from "@/lib/db/queries";
import { seriesDisplayLabel } from "@/lib/format";

// The list of papers only changes when the operator publishes or
// unpublishes something using the command-line tool — it doesn't change
// continuously. So we cache this page for 5 minutes at a time. That means
// most visitors get a fast, cached version of the page instead of a fresh
// database read every time, at the cost of the page possibly being up to
// 5 minutes out of date right after something new gets published.
export const revalidate = 300;

export default async function HomePage() {
  // These four pieces of data don't depend on each other, so we fetch
  // them all at the same time instead of one after another — which means
  // this page loads about four times faster than it otherwise would.
  const [examSeries, subjects, years, recent] = await Promise.all([
    listExamSeries(),
    listSubjects(),
    listYears(),
    listRecentPublicArtifacts(5),
  ]);

  return (
    <>
      <h1 className="visually-hidden">SI National Exam Archive</h1>

      <p className="lede">
        The SI National Exam Archive is a free, publicly searchable
        collection of past Solomon Islands national examination papers. It
        was built to help students revise using papers similar to the ones
        they&apos;ll actually sit. Browse by exam level, year, and subject,
        or search directly for a specific paper below. The archive is
        actively growing, not every past exam is available yet, but more
        papers are being added as they&apos;re gathered and verified.
      </p>
      <p className="hint" style={{ marginTop: "0.5rem" }}>
        Spotted a paper that&apos;s missing, wrong, or looks altered?{" "}
        <Link href="/about#corrections">Report an issue</Link>.
      </p>

      <div className="card-grid" style={{ marginTop: "1.5rem" }}>
        <div className="card">
          <h2>Search papers</h2>
          <form method="get" action="/results" aria-label="Search the archive" className="search-form">
            <div className="field">
              <label htmlFor="q" className="visually-hidden">
                Search
              </label>
              <input type="search" id="q" name="q" placeholder="e.g. Mathematics 2018" style={{ maxWidth: "none" }} />
            </div>

            <div className="search-form__filters field">
              <div>
                <label htmlFor="series" className="visually-hidden">
                  Exam level
                </label>
                <select id="series" name="series" defaultValue="">
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
                <select id="year" name="year" defaultValue="">
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
                <select id="subject" name="subject" defaultValue="">
                  <option value="">Any subject</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.subjectCode ?? s.id}>
                      {s.canonicalName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button type="submit">Search</button>
          </form>
        </div>

        <div className="card">
          <h2>Browse the archive</h2>
          <p className="lede" style={{ marginBottom: "1rem" }}>
            Explore papers by exam level, year and subject.
          </p>
          <ul className="list-rows">
            {examSeries.map((s) => (
              <li key={s.code}>
                <Link href={`/browse/${s.code}`} className="list-row">
                  <span className="list-row__label">{seriesDisplayLabel(s.code)}</span>
                  <span className="list-row__chevron" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {recent.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <div className="section-header">
            <h2>Recently added</h2>
            <Link href="/results">View all</Link>
          </div>

          <div className="data-table table-scroll">
            <table>
              <caption className="visually-hidden">Recently added papers</caption>
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
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Year">{r.year}</td>
                    <td data-label="Subject">{r.subject}</td>
                    <td data-label="Exam level">{seriesDisplayLabel(r.examSeriesCode)}</td>
                    <td>
                      <Link href={`/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
