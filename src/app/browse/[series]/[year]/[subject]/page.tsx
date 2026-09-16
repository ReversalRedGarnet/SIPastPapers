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
  const examSeries = await listExamSeries();
  const series = examSeries.find((s) => s.code === seriesCode);
  if (!series) return undefined;
  const years = listBrowseYears();
  if (!years.includes(year)) return undefined;
  const allSubjects = await listSubjects();
  const subject = allSubjects.find((s) => (s.subjectCode ?? s.id) === subjectSlug);
  if (!subject) return undefined;
  return { examSeries, series, years, year, subject };
}

export async function generateMetadata({ params }: SubjectPageProps): Promise<Metadata> {
  const { series: seriesCode, year, subject: subjectSlug } = await params;
  const context = await loadContext(seriesCode, year, subjectSlug);
  if (!context) return { title: "Not found" };
  return { title: `${context.subject.canonicalName} ${context.year} — ${seriesDisplayLabel(context.series.code)}` };
}

// The actual paper list for one series/year/subject -- shortest interval
// of the browse tree since it's the page closest to "did a new paper just
// get published."
export const revalidate = 300;

// Required for `revalidate` to actually enable ISR on a dynamic segment --
// see the same note in src/app/browse/[series]/page.tsx. series x the fixed
// browse year range x subjects is still small (a few hundred combinations),
// so prerendering all of them is cheap; combos with no published papers yet
// just prerender to the existing empty-state UI.
export async function generateStaticParams() {
  const examSeries = await listExamSeries();
  const subjects = await listSubjects();
  const years = listBrowseYears();
  const params: { series: string; year: string; subject: string }[] = [];
  for (const s of examSeries) {
    for (const year of years) {
      for (const subject of subjects) {
        params.push({ series: s.code, year: String(year), subject: subject.subjectCode ?? subject.id });
      }
    }
  }
  return params;
}

export default async function SubjectPage({ params }: SubjectPageProps) {
  const { series: seriesCode, year: yearParam, subject: subjectSlug } = await params;
  const context = await loadContext(seriesCode, yearParam, subjectSlug);
  if (!context) notFound();
  const { examSeries, series, years, year, subject } = context;

  const papers = await searchPublicArtifacts({ series: seriesCode, year: String(year), subject: subjectSlug });
  const availability = await getExamContentAvailability();

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
          <Link href="/browse">Browse</Link> ›{" "}
          <Link href={`/browse/${seriesCode}`}>{seriesDisplayLabel(series.code)}</Link> ›{" "}
          <Link href={`/browse/${seriesCode}/${year}`}>{year}</Link> › {subject.canonicalName}
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
                  <Link href={href} className="list-row">
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
