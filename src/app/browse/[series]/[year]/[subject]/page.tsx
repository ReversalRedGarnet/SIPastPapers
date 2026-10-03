import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getExamContentAvailability, listExamSeries, listSubjects, searchPublicArtifacts } from "@/lib/db/queries";
import { BrowseSidebar } from "@/components/BrowseSidebar";
import { artifactListLabel } from "@/lib/artifact-naming";
import { Badge } from "@/components/Badge";
import { listBrowseYears } from "@/lib/browse-years";
import { seriesDisplayLabel, statusLabel, statusTone } from "@/lib/format";

interface SubjectPageProps {
  params: Promise<{ series: string; year: string; subject: string }>;
}

async function loadContext(seriesCode: string, yearParam: string, subjectSlug: string) {
  const year = Number(yearParam);
  if (!Number.isInteger(year)) return undefined;
  // These two don't depend on each other — each is separately checked
  // against the page's web address below — so we fetch them both at once
  // instead of one after another.
  const [examSeries, allSubjects] = await Promise.all([listExamSeries(), listSubjects()]);
  const series = examSeries.find((s) => s.code === seriesCode);
  if (!series) return undefined;
  const years = listBrowseYears();
  if (!years.includes(year)) return undefined;
  const subject = allSubjects.find((s) => (s.subjectCode ?? s.id) === subjectSlug);
  if (!subject) return undefined;
  return { examSeries, series, years, year, subject };
}

export async function generateMetadata({ params }: SubjectPageProps): Promise<Metadata> {
  const { series: seriesCode, year, subject: subjectSlug } = await params;
  const context = await loadContext(seriesCode, year, subjectSlug);
  if (!context) return { title: "Not found" };
  const label = seriesDisplayLabel(context.series.code);
  // Same query as the page itself (React's cache() shares the result). No
  // paper with a file -- nothing yet, or only "not yet recovered"
  // placeholders -- is a thin page: kept out of search results (and out of
  // the sitemap), links still followed.
  const papers = await searchPublicArtifacts({ series: seriesCode, year: String(context.year), subject: subjectSlug });
  return {
    title: `${context.subject.canonicalName} ${context.year} — ${label}`,
    description: `${context.subject.canonicalName} past exam papers for ${label} ${context.year} — Solomon Islands national exam archive.`,
    alternates: { canonical: `/browse/${context.series.code}/${context.year}/${subjectSlug}` },
    ...(!papers.some((p) => p.file) && { robots: { index: false, follow: true } }),
  };
}

// This is the actual list of papers for one exam series/year/subject —
// the page in the browse hierarchy closest to "did a new paper just get
// published", so it gets the shortest cache time of any browse page.
export const revalidate = 300;

// Returning an empty list means "don't build any of these pages ahead of
// time" -- each one is built the first time someone visits it, then cached
// (refreshed every `revalidate` seconds above). Pre-building all ~630
// series × year × subject combinations made every deployment rewrite all
// of them as ISR writes, whether or not anyone visited them. Next.js needs
// this function to exist, even empty, to cache pages for addresses it only
// finds out about while running. Made-up addresses never get this far:
// src/proxy.ts answers them with a 404 first.
export async function generateStaticParams() {
  return [];
}

export default async function SubjectPage({ params }: SubjectPageProps) {
  const { series: seriesCode, year: yearParam, subject: subjectSlug } = await params;
  const context = await loadContext(seriesCode, yearParam, subjectSlug);
  if (!context) notFound();
  const { examSeries, series, years, year, subject } = context;

  // These two don't depend on each other, so we fetch them both at once
  // instead of one after another.
  const [papers, availability] = await Promise.all([
    searchPublicArtifacts({ series: seriesCode, year: String(year), subject: subjectSlug }),
    getExamContentAvailability(),
  ]);

  return (
    <div className="browse-layout">
      <BrowseSidebar
        examSeries={examSeries}
        activeSeriesCode={seriesCode}
        years={years}
        activeYear={year}
        availability={availability}
      />

      <div className="browse-content">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link prefetch={false} href="/browse">Browse</Link> ›{" "}
          <Link prefetch={false} href={`/browse/${seriesCode}`}>{seriesDisplayLabel(series.code)}</Link> ›{" "}
          <Link prefetch={false} href={`/browse/${seriesCode}/${year}`}>{year}</Link> › {subject.canonicalName}
        </nav>

        <h1>{subject.canonicalName}</h1>
        <p className="lede" style={{ marginBottom: "1.25rem" }}>
          {seriesDisplayLabel(series.code)} · {year}
        </p>

        {papers.length === 0 ? (
          <p className="empty-state">No papers have been published for this subject yet.</p>
        ) : (
          <ul className="list-rows">
            {papers.map((paper) => {
              const href = `/exams/${seriesCode}/${year}/${subjectSlug}/${paper.slug}`;
              const label = artifactListLabel(paper.artifactType, paper.paperNumber);
              return (
                <li key={paper.id}>
                  <Link href={href} className="list-row" prefetch={false}>
                    <span className="list-row__label">{label}</span>
                    {!paper.file && <Badge tone={statusTone(paper.status)}>{statusLabel(paper.status)}</Badge>}
                    <span className="list-row__chevron" aria-hidden="true">
                      ›
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
