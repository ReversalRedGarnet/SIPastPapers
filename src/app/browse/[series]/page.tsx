import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getExamContentAvailability, listExamSeries } from "@/lib/db/queries";
import { BrowseSidebar } from "@/components/BrowseSidebar";
import { Badge } from "@/components/Badge";
import { emptyYearsForSeries, listBrowseYears, seriesIsEmpty } from "@/lib/browse-years";
import { seriesDisplayLabel } from "@/lib/format";

// "Route parameters" (`params`, different from `searchParams` -- see
// src/app/results/page.tsx) are the changeable segments of the address
// itself, marked in the folder structure by square brackets. This file
// lives at `app/browse/[series]/page.tsx`, so visiting `/browse/sisc-l1`
// makes `params` equal `{ series: "sisc-l1" }` -- Next.js reads the actual
// address and fills this in automatically.
interface SeriesPageProps {
  params: Promise<{ series: string }>;
}

// `generateMetadata` is a Next.js convention function used instead of a
// plain `metadata` export (see src/app/layout.tsx) whenever the page's
// title/description depends on data that has to be looked up first --
// here, the specific exam series being viewed.
export async function generateMetadata({ params }: SeriesPageProps): Promise<Metadata> {
  const { series: seriesCode } = await params;
  const examSeries = await listExamSeries();
  // `.find()` returns the first item in a list for which the given
  // function returns true, or `undefined` if nothing matches -- unlike
  // `.filter()` (see src/app/sitemap.ts), which returns *every* match as a
  // new list.
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

// `generateStaticParams` is a Next.js convention function that lists every
// value of `params` (see the interface above) the site should build a page
// for in advance, rather than waiting for a real visitor to ask for it --
// here, one entry per exam series code.
//
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
  // `notFound()` is a Next.js helper that immediately stops rendering this
  // page and shows the site's 404 "not found" page instead (see
  // src/app/not-found.tsx) -- used here when the address mentions an exam
  // series that doesn't actually exist.
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
