// `Link` is Next.js's version of an HTML link (`<a>`). Using it instead of
// a plain link lets Next.js navigate to the new page without a full,
// slower browser page reload.
import Link from "next/link";
import { listExamSeries, listRecentPublicArtifacts, listSubjects, listYears } from "@/lib/db/queries";
import { seriesDisplayLabel } from "@/lib/format";

// Exam content changes only when the operator publishes/unpublishes via
// the CLI (bursty, not continuous) — ISR with a 5-minute revalidate window
// means most visitors hit a cached page instead of a live DB round trip,
// at the cost of up to ~5 minutes' staleness after a fresh publish.
export const revalidate = 300;

// This whole file describes the homepage. Because the function is
// `export default`, Next.js automatically treats it as "the page that
// lives at this file's address" -- there's no separate step to wire it up.
// It's also a "Server Component": by default in this project, every page
// runs on the website's own server, not in the visitor's browser, which is
// what lets it safely talk to the database directly below. The function is
// declared `async` because it needs to `await` (pause and wait for) slow
// work -- here, several database reads -- before it has everything it
// needs to describe the finished page.
export default async function HomePage() {
  // `await` pauses this function until whatever's on its right finishes,
  // then continues with the result. `Promise.all([...])` runs a whole list
  // of separate slow operations *at the same time* instead of one after
  // another, and only continues once every one of them is done -- so all
  // four database questions below happen together instead of one, then the
  // next, then the next (see the comment beneath for why that's safe here).
  // The square brackets on the left (`const [a, b, c, d] = ...`) are "array
  // destructuring": Promise.all hands back a list of four results in the
  // same order they were requested, and this line unpacks that list into
  // four separately named variables in one step.
  //
  // Four independent reads -- none depends on another's result -- so they
  // run concurrently instead of as four sequential round trips to Neon.
  const [examSeries, subjects, years, recent] = await Promise.all([
    listExamSeries(),
    listSubjects(),
    listYears(),
    listRecentPublicArtifacts(5),
  ]);

  // Everything from here to the end of the function is "JSX" -- HTML-like
  // markup written directly inside the code, describing what should appear
  // on the page. It's not real HTML: anything inside curly braces `{...}`
  // is regular code (a value, a variable, an expression) that gets dropped
  // into the page at that spot. The outer `<>` and `</>` are an empty
  // "Fragment" -- a wrapper with no visual effect of its own, used because
  // JSX requires everything to be wrapped in a single top-level tag, even
  // when there's no sensible real element to wrap things in.
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
                  {/* `.map()` turns each item in a list into something else -- here,
                      each exam series becomes one <option>. It's the standard way to
                      render a list of JSX elements from a list of data. React needs a
                      `key` on each item produced this way (a stable, unique value, not
                      an array position) so it can efficiently tell which items changed
                      the next time this list re-renders. */}
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
                  {/* `??` again (see src/lib/format.ts) -- use the subject code if it
                      has one, otherwise fall back to its id. */}
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

      {/* `condition && (...)` is a common JSX trick for "only show this if
          the condition is true." If `recent.length > 0` is false, JavaScript
          never evaluates the right-hand side, so nothing renders at all;
          if it's true, the JSX on the right is what gets shown. */}
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
                      {/* Template literal again (see src/lib/format.ts) -- builds the
                          paper's address by dropping its fields into the URL text. */}
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
