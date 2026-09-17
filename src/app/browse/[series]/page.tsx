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
  if (!series) return { title: "Not found" };

  const label = seriesDisplayLabel(series.code);
  const title = `${label} past papers`;
  const description = `Browse past ${label} exam papers from the Solomon Islands national exam archive, by year and subject.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
  };
}

// The list of possible years itself never changes (see listBrowseYears).
// What does change is which years actually have content, and that only
// updates when the operator publishes something using the command-line
// tool — which happens occasionally, not continuously. So a 15-minute
// cache is fine here.
export const revalidate = 900;

// This is required to make the caching above actually take effect for a
// page whose web address has a variable part in it (the exam series
// code). Without this, Next.js has no way of knowing in advance which
// exam series pages exist, so it would always render this page completely
// fresh every time, ignoring the cache setting above. There are only a
// handful of exam series, so pre-building all of their pages ahead of
// time is cheap and quick.
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
