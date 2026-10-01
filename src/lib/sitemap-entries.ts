import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import type { ExamSeries, PublicExamRecord } from "@/types/domain";

/**
 * Builds the sitemap's list of pages from already-fetched data. Kept apart
 * from src/app/sitemap.ts (which fetches that data through Next.js's cache)
 * so tests can check exactly which papers end up listed.
 */
export function buildSitemapEntries(
  examSeries: ExamSeries[],
  records: PublicExamRecord[],
  years: number[]
): MetadataRoute.Sitemap {
  // Only include papers that actually have a downloadable file — a paper
  // that's just marked "not yet recovered" has no real document behind
  // it, so its page would be mostly empty and isn't worth pointing search
  // engines to.
  //
  // `.filter()` builds a new, shorter list containing only the items for
  // which the given function returns true -- here, only records that have
  // both a file and a subject slug are kept.
  const withFiles = records.filter((r) => r.file && r.subjectSlug);

  const entries: MetadataRoute.Sitemap = [
    { url: SITE_URL, changeFrequency: "daily", priority: 1 },
    { url: `${SITE_URL}/about`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/browse`, changeFrequency: "weekly", priority: 0.8 },
  ];

  for (const series of examSeries) {
    entries.push({ url: `${SITE_URL}/browse/${series.code}`, changeFrequency: "weekly", priority: 0.8 });
    for (const year of years) {
      entries.push({ url: `${SITE_URL}/browse/${series.code}/${year}`, changeFrequency: "weekly", priority: 0.7 });
    }
  }

  // We also include subject pages (even though nothing above strictly
  // required it) since each one shows a genuinely unique list of papers
  // for that subject, and is worth having search engines find. As above,
  // we only include a subject page if at least one of its papers actually
  // has a file to show.
  const subjectPaths = new Set<string>();
  for (const r of withFiles) {
    subjectPaths.add(`${r.examSeriesCode}/${r.year}/${r.subjectSlug}`);
  }
  for (const path of subjectPaths) {
    entries.push({ url: `${SITE_URL}/browse/${path}`, changeFrequency: "weekly", priority: 0.6 });
  }

  for (const r of withFiles) {
    entries.push({
      url: `${SITE_URL}/exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`,
      changeFrequency: "monthly",
      priority: 0.5,
    });
  }

  return entries;
}
