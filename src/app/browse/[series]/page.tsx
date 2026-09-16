import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getExamContentAvailability, listExamSeries } from "@/lib/db/queries";
import { BrowseSidebar } from "@/components/BrowseSidebar";
import { Badge } from "@/components/Badge";
import { emptyYearsForSeries, listBrowseYears, seriesIsEmpty } from "@/lib/browse-years";
import { seriesDisplayLabel } from "@/lib/format";

interface SeriesPageProps {
  params: Promise<{ series: string }>;
}

export async function generateMetadata({ params }: SeriesPageProps): Promise<Metadata> {
  const { series: seriesCode } = await params;
  const examSeries = await listExamSeries();
  const series = examSeries.find((s) => s.code === seriesCode);
  return { title: series ? seriesDisplayLabel(series.code) : "Not found" };
}

// The year range itself is fixed (see listBrowseYears); what changes here
// is which years have content, updated whenever the operator publishes via
// the CLI -- infrequent, batch-driven.
export const revalidate = 900;

// Required for `revalidate` to actually enable ISR on a dynamic segment --
// without generateStaticParams, Next.js has no known param set to prerender
// and the route stays fully dynamic regardless of `revalidate`. Cardinality
// is tiny (a handful of exam series), so prerendering all of them is cheap.
export async function generateStaticParams() {
  const examSeries = await listExamSeries();
  return examSeries.map((s) => ({ series: s.code }));
}

export default async function SeriesPage({ params }: SeriesPageProps) {
  const { series: seriesCode } = await params;
  const examSeries = await listExamSeries();
  const series = examSeries.find((s) => s.code === seriesCode);
  if (!series) notFound();

  const years = listBrowseYears();
  const availability = await getExamContentAvailability();
  const isEmpty = seriesIsEmpty(seriesCode, availability);
  const emptyYears = isEmpty ? new Set<number>() : emptyYearsForSeries(seriesCode, years, availability);

  return (
    <div className="browse-layout">
      <BrowseSidebar
        examSeries={examSeries}
        activeSeriesCode={seriesCode}
        years={years}
        availability={availability}
      />

      <div className="browse-content">
        <nav aria-label="Breadcrumb" className="breadcrumb">
          <Link href="/browse">Browse</Link> › {seriesDisplayLabel(series.code)}
        </nav>

        <h1>{seriesDisplayLabel(series.code)}</h1>
        <p className="lede" style={{ marginBottom: "1.25rem" }}>
          Select a year to view available subjects.
        </p>

        {isEmpty && (
          <p className="empty-state" style={{ marginBottom: "1.25rem" }}>
            No papers have been published for this exam level yet. Years are
            listed below so you can check back as they&apos;re added.
          </p>
        )}

        <ul className="list-rows">
          {years.map((y) => (
            <li key={y}>
              <Link href={`/browse/${seriesCode}/${y}`} className="list-row">
                <span className="list-row__label">{y}</span>
                {!isEmpty && emptyYears.has(y) && <Badge tone="neutral">No papers yet</Badge>}
                <span className="list-row__chevron" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
