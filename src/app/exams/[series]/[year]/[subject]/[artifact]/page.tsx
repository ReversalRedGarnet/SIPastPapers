import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicArtifactBySlug, listSubjectArtifacts } from "@/lib/db/queries";
import { artifactListLabel } from "@/lib/artifact-naming";
import { formatBytes, seriesDisplayLabel } from "@/lib/format";
import { SITE_NAME, SITE_URL } from "@/lib/site";
import { reportIssueAction } from "./actions";

interface DocumentPageProps {
  params: Promise<{
    series: string;
    year: string;
    subject: string;
    artifact: string;
  }>;
  searchParams: Promise<{ reported?: string; reportError?: string }>;
}

function loadRecord(params: {
  series: string;
  year: string;
  subject: string;
  artifact: string;
}) {
  const year = Number(params.year);
  if (!Number.isInteger(year)) return Promise.resolve(undefined);
  return getPublicArtifactBySlug(params.series, year, params.subject, params.artifact);
}

export async function generateMetadata({
  params,
}: DocumentPageProps): Promise<Metadata> {
  const found = await loadRecord(await params);
  if (!found) return { title: "Not found" };
  const { record } = found;
  const label = artifactListLabel(record.artifactType, record.paperNumber);
  const seriesLabel = seriesDisplayLabel(record.examSeriesCode);
  const title = `${seriesLabel} ${record.subject} ${record.year} — ${label}`;
  const description = `${label} for ${record.subject} — ${seriesLabel} ${record.year} exam paper from the Solomon Islands national exam archive, free to view and download.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
  };
}

// This content only changes when the operator publishes/unpublishes
// something via the command-line tool — occasional, not continuous — so
// the same 5-minute cache tier as the subject-listing page (one level up
// in the browse hierarchy) works fine here too.
export const revalidate = 300;

const ISSUE_TYPES = [
  { value: "wrong_metadata", label: "Wrong year, subject, or paper number" },
  { value: "missing_or_corrupt", label: "Pages missing or file won't open" },
  { value: "suspected_authenticity", label: "Looks altered or mismatched" },
  { value: "rights_concern", label: "Rights or ownership concern" },
  { value: "other", label: "Something else" },
];

export default async function DocumentPage({ params, searchParams }: DocumentPageProps) {
  const found = await loadRecord(await params);
  if (!found) notFound();
  const { record, related } = found;
  const { reported, reportError } = await searchParams;

  const currentPath = `/exams/${record.examSeriesCode}/${record.year}/${record.subjectSlug}/${record.slug}`;
  const typeLabel = artifactListLabel(record.artifactType, record.paperNumber);
  const seriesLabel = seriesDisplayLabel(record.examSeriesCode);

  // We only add this structured data (used by search engines to build
  // rich search results) when there's an actual file to describe. A paper
  // that's just marked "not yet recovered" has no real document, so
  // claiming a downloadable file exists for it would be describing
  // something that isn't actually there. This deliberately doesn't name
  // any official publisher or authority anywhere — it only claims what's
  // already stated on the About page's "Ownership and independence"
  // section.
  const jsonLd = record.file
    ? {
        "@context": "https://schema.org",
        "@type": ["LearningResource", "DigitalDocument"],
        name: `${seriesLabel} ${record.subject} ${record.year} — ${typeLabel}`,
        description: `${typeLabel} for ${record.subject} — ${seriesLabel} ${record.year} exam paper from the Solomon Islands national exam archive.`,
        url: `${SITE_URL}${currentPath}`,
        inLanguage: "en",
        isAccessibleForFree: true,
        learningResourceType: typeLabel,
        educationalLevel: seriesLabel,
        about: { "@type": "Thing", name: record.subject },
        temporalCoverage: String(record.year),
        publisher: { "@type": "Organization", name: SITE_NAME },
        associatedMedia: {
          "@type": "MediaObject",
          contentUrl: `${SITE_URL}/api/files/${record.file.id}`,
          encodingFormat: record.file.mime,
        },
      }
    : null;

  const subjectArtifacts = await listSubjectArtifacts(record.examSeriesCode, record.subjectSlug);
  // `.findIndex()` is like `.find()` (see src/app/browse/[series]/page.tsx)
  // but hands back the matching item's position in the list (a number,
  // starting at 0) instead of the item itself -- useful here to look at the
  // items right before/after it.
  const currentIndex = subjectArtifacts.findIndex((r) => r.id === record.id);
  const prevPaper = currentIndex > 0 ? subjectArtifacts[currentIndex - 1] : undefined;
  const nextPaper =
    currentIndex >= 0 && currentIndex < subjectArtifacts.length - 1
      ? subjectArtifacts[currentIndex + 1]
      : undefined;

  // Reading inside-out: `.filter()` keeps only other years' papers,
  // `.map()` reduces each one down to just its year number, `new Set(...)`
  // (see src/lib/browse-years.ts) throws away any repeated years, and
  // `Array.from(...)` turns that Set back into a plain array so `.sort()`
  // can be used on it (Sets don't have a `.sort()` of their own). `.sort()`
  // takes a function that compares two items (`a` and `b`) at a time and
  // returns a negative number if `a` should come first, positive if `b`
  // should; `b - a` sorts numbers newest-first (largest number first).
  const otherYears = Array.from(
    new Set(subjectArtifacts.filter((r) => r.year !== record.year).map((r) => r.year))
  ).sort((a, b) => b - a);
  // `(typeof subjectArtifacts)[number]` asks TypeScript "what's the type of
  // one single item inside the subjectArtifacts array?" -- handy for typing
  // a helper function that operates on one of those items, without needing
  // to give that item shape its own separate name.
  const paperHref = (r: (typeof subjectArtifacts)[number]) =>
    `/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`;

  return (
    <>
      {/* `dangerouslySetInnerHTML` is React's deliberately scary-sounding name
          for inserting raw HTML text directly into the page, bypassing
          React's normal, safer way of building elements. It's named that way
          as a warning: doing this with untrusted/visitor-supplied text is
          exactly how a website can become vulnerable to attacks. It's safe
          here specifically because `jsonLd` is data this same function just
          built moments ago from trusted database content, not something a
          visitor typed in. */}
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}

      {/* JSX normally collapses/trims extra whitespace between elements when
          they're on separate lines. Writing `{" "}` -- a literal space
          wrapped in curly braces so it's treated as an explicit value, not
          formatting -- forces a real space to appear there, so text doesn't
          run together at the line break below. */}
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link href="/browse">Browse</Link> ›{" "}
        <Link href={`/browse/${record.examSeriesCode}`}>{seriesLabel}</Link> ›{" "}
        <Link href={`/browse/${record.examSeriesCode}/${record.year}`}>{record.year}</Link> ›{" "}
        <Link href={`/browse/${record.examSeriesCode}/${record.year}/${record.subjectSlug}`}>
          {record.subject}
        </Link>{" "}
        › {typeLabel}
      </nav>

      <div className="doc-layout">
        <div className="doc-meta card">
          <h1>{record.subject}</h1>
          <p className="doc-subtitle">
            {seriesLabel} · {record.year}
          </p>

          {record.file ? (
            <>
              <div className="doc-actions">
                <a className="button" href={`/api/files/${record.file.id}?dl=1`}>
                  Download ({formatBytes(record.file.bytes)})
                </a>
                <a className="button secondary" href={`/api/files/${record.file.id}`} target="_blank" rel="noreferrer">
                  Open in new tab
                </a>
              </div>

              <details className="tech-details">
                <summary>More information</summary>
                <dl className="meta-table">
                  <dt>File size</dt>
                  <dd>{formatBytes(record.file.bytes)}</dd>
                  <dt>SHA-256</dt>
                  <dd style={{ wordBreak: "break-all" }}>{record.file.sha256}</dd>
                </dl>
              </details>
            </>
          ) : (
            <p className="empty-state">
              This paper has not yet been recovered for the archive. It is
              listed so the gap is visible rather than hidden.
            </p>
          )}

          {record.source?.attribution && (
            <p className="hint" style={{ marginTop: "1rem" }}>
              {record.source.attribution}
            </p>
          )}

          <p className="hint" style={{ marginTop: "1rem" }}>
            Spotted a problem with this paper?{" "}
            <a href="#report-a-problem">Report an issue</a>.
          </p>
        </div>

        <div className="doc-viewer">
          {record.file ? (
            <iframe src={`/api/files/${record.file.id}`} className="pdf-frame" title={`Preview of ${record.title}`} />
          ) : (
            <div className="empty-state" style={{ border: "none" }}>
              No file to preview yet.
            </div>
          )}
        </div>
      </div>

      {(prevPaper || nextPaper) && (
        <nav aria-label="Adjacent papers in this subject" className="paper-pager">
          {prevPaper ? (
            <Link href={paperHref(prevPaper)} className="paper-pager__link paper-pager__link--prev">
              <span className="paper-pager__direction">‹ Previous</span>
              <span className="paper-pager__label">
                {prevPaper.subject} {prevPaper.year} — {artifactListLabel(prevPaper.artifactType, prevPaper.paperNumber)}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {nextPaper ? (
            <Link href={paperHref(nextPaper)} className="paper-pager__link paper-pager__link--next">
              <span className="paper-pager__direction">Next ›</span>
              <span className="paper-pager__label">
                {nextPaper.subject} {nextPaper.year} — {artifactListLabel(nextPaper.artifactType, nextPaper.paperNumber)}
              </span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}

      {otherYears.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2>More papers in this subject</h2>
          <ul className="list-rows">
            {otherYears.map((y) => (
              <li key={y}>
                <Link href={`/browse/${record.examSeriesCode}/${y}/${record.subjectSlug}`} className="list-row">
                  <span className="list-row__label">
                    {record.subject} {y}
                  </span>
                  <span className="list-row__chevron" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {related.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2>Related papers</h2>
          <ul className="list-rows">
            {related.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`}
                  className="list-row"
                >
                  <span className="list-row__label">
                    {r.subject} {r.year} — {artifactListLabel(r.artifactType, r.paperNumber)}
                  </span>
                  <span className="list-row__chevron" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div id="report-a-problem" style={{ marginTop: "2rem", scrollMarginTop: "1.5rem" }} className="card">
        <h2>Report a problem</h2>
        <p className="lede">
          Spotted a wrong year, missing pages, or a rights concern with this
          record? Tell us below, or read the full{" "}
          <Link href="/about#corrections">correction and takedown process</Link>.
        </p>

        {reported && (
          <div className="confirmation" role="status">
            <p>Thanks — this has been logged and will be reviewed.</p>
          </div>
        )}
        {/* `decodeURIComponent` reverses `encodeURIComponent` (see
            ./actions.ts), turning the escaped text back from the URL's
            query string into ordinary readable text. */}
        {reportError && (
          <div className="confirmation" role="alert">
            <p>{decodeURIComponent(reportError)}</p>
          </div>
        )}

        <form aria-label="Report a problem with this record">
          <input type="hidden" name="artifactId" value={record.id} />
          <input type="hidden" name="returnTo" value={currentPath} />

          <div className="field">
            <label htmlFor="issueType">What&apos;s wrong?</label>
            <select id="issueType" name="issueType" required defaultValue="">
              <option value="" disabled>
                Select an issue type
              </option>
              {ISSUE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="description">Details</label>
            <textarea id="description" name="description" required />
          </div>

          <div className="field">
            <label htmlFor="contact">
              Your email <span className="hint">(optional, only if you&apos;re happy to be contacted)</span>
            </label>
            <input type="email" id="contact" name="contact" />
          </div>

          <div className="form-actions">
            {/* Handing a Server Action (see ./actions.ts) straight to a button's
                `formAction` is what wires this plain HTML form up to run
                server-side code on submit -- no separate click handler or
                fetch() call needed. */}
            <button type="submit" formAction={reportIssueAction}>
              Submit report
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
