import type { MetadataRoute } from "next";
import { listExamSeries, searchPublicArtifactsCached } from "@/lib/db/queries";
import { listBrowseYears } from "@/lib/browse-years";
import { buildSitemapEntries } from "@/lib/sitemap-entries";

// The list of pages only changes when new papers get published through
// the command-line tool, so it's fine to only rebuild this sitemap once
// an hour — matching the same refresh interval used by the browse pages
// themselves.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [examSeries, records] = await Promise.all([
    listExamSeries(),
    // Reuses the same cached, "show everything" query the results page
    // uses. A search engine re-fetching the sitemap shouldn't force a
    // full, fresh read of every single paper every time.
    searchPublicArtifactsCached({}),
  ]);
  return buildSitemapEntries(examSeries, records, listBrowseYears());
}
