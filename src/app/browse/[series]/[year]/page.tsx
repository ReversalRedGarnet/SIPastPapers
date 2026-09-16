import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getExamContentAvailability,
  listExamSeries,
  listPublicSubjectsForInstance,
  listPublishedFilesForInstance,
} from "@/lib/db/queries";
import { BrowseSidebar } from "@/components/BrowseSidebar";
import { listBrowseYears } from "@/lib/browse-years";
import { seriesDisplayLabel } from "@/lib/format";

interface YearPageProps {
  params: Promise<{ series: string; year: string }>;
}

async function loadContext(seriesCode: string, yearParam: string) {
  const year = Number(yearParam);
  if (!Number.isInteger(year)) return undefined;
  const examSeries = await listExamSeries();
  const series = examSeries.find((s) => s.code === seriesCode);
  if (!series) return undefined;
  const years = listBrowseYears();
  if (!years.includes(year)) return undefined;
  return { examSeries, series, years, year };
}

export async function generateMetadata({ params }: YearPageProps): Promise<Metadata> {
  const { series: seriesCode, year } = await params;
  const context = await loadContext(seriesCode, year);
  if (!context) return { title: "Not found" };
  return { title: `${seriesDisplayLabel(context.series.code)} ${context.year}` };
}

// Subjects available for a series/year only change as papers get published
// for that instance -- infrequent, batch-driven.
export const revalidate = 900;

// Required for `revalidate` to actually enable ISR on a dynamic segment --
// see the same note in src/app/browse/[series]/page.tsx. Cardinality is
// still small (series x the fixed browse year range), so prerendering all
// combinations is cheap.
export async function generateStaticParams() {
  const examSeries = await listExamSeries();
  const years = listBrowseYears();
  const params: { series: string; year: string }[] = [];
  for (const s of examSeries) {
    for (const year of years) {
      params.push({ series: s.code, year: String(year) });
    }
  }
  return params;
}

export default async function YearPage({ params }: YearPageProps) {
  const { series: seriesCode, year: yearParam } = await params;
  const context = await loadContext(seriesCode, yearParam);
  if (!context) notFound();
  const { examSeries, series, years, year } = context;

  const subjects = await listPublicSubjectsForInstance(seriesCode, year);
  const availability = await getExamContentAvailability();
  const publishedFiles = await listPublishedFilesForInstance(seriesCode, year);

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
          <Link href={`/browse/${seriesCode}`}>{seriesDisplayLabel(series.code)}</Link> › {year}
        </nav>

        <h1>{year}</h1>
        <p className="lede" style={{ marginBottom: "1.25rem" }}>
          Select a subject to view available papers.
        </p>

        {publishedFiles.length > 0 && (
          <a
            className="button button--gradient"
            style={{ marginBottom: "1.25rem", display: "inline-block" }}
            href={`/api/download-year/${seriesCode}/${year}`}
          >
            Download all ({publishedFiles.length} {publishedFiles.length === 1 ? "paper" : "papers"})
          </a>
        )}

        {subjects.length === 0 ? (
          <p className="empty-state">No papers have been published for this year yet.</p>
        ) : (
          <ul className="list-rows">
            {subjects.map((subject) => (
              <li key={subject.slug}>
                <Link href={`/browse/${seriesCode}/${year}/${subject.slug}`} className="list-row">
                  <span className="list-row__label">{subject.name}</span>
                  <span className="list-row__meta">
                    {subject.count} {subject.count === 1 ? "paper" : "papers"}
                  </span>
                  <span className="list-row__chevron" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
