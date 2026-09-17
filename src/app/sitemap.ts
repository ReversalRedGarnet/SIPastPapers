import type { MetadataRoute } from "next";
import { listExamSeries, searchPublicArtifactsCached } from "@/lib/db/queries";
import { listBrowseYears } from "@/lib/browse-years";
import { SITE_URL } from "@/lib/site";

// Content changes only when the operator publishes via the CLI -- matches
// the revalidate window used by the browse tree pages themselves.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [examSeries, records] = await Promise.all([
    listExamSeries(),
    // Cached, unfiltered read -- same query /results uses for "show
    // everything". A crawler re-fetching the sitemap shouldn't force a
    // fresh full-table read every time.
    searchPublicArtifactsCached({}),
  ]);
  const years = listBrowseYears();

  // Only records with an actual file are worth sending a crawler to --
  // 'not_yet_recovered' placeholders have no document, so a page for one is
  // thin/empty content rather than something worth indexing.
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

  // Subject pages beyond the literal ask, added because they're genuine,
  // unique, indexable content (one subject's paper list) -- but only where
  // at least one paper actually has a file, for the same thin-content
  // reason as the artifact filter above.
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
