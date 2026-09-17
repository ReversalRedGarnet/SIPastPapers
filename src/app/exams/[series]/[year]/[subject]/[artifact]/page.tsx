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
  const currentIndex = subjectArtifacts.findIndex((r) => r.id === record.id);
  const prevPaper = currentIndex > 0 ? subjectArtifacts[currentIndex - 1] : undefined;
  const nextPaper =
    currentIndex >= 0 && currentIndex < subjectArtifacts.length - 1
      ? subjectArtifacts[currentIndex + 1]
      : undefined;

  const otherYears = Array.from(
    new Set(subjectArtifacts.filter((r) => r.year !== record.year).map((r) => r.year))
  ).sort((a, b) => b - a);
  const paperHref = (r: (typeof subjectArtifacts)[number]) =>
    `/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`;

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}

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
            <button type="submit" formAction={reportIssueAction}>
              Submit report
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
