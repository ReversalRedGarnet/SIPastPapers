/**
 * Lists every public page address the site links to or puts in its
 * sitemap, from the TEST database (the Neon branch in .env.test.local --
 * see src/lib/db/test-database-env.ts), one per line and sorted:
 *
 *   npx tsx scripts/public-urls.ts > urls.txt
 *
 * Each line is "sitemap <path>" or "link <path>": the browse pages, every
 * subject a year page lists, and every paper page with the links on it
 * (breadcrumb, other years, previous/next, related). The addresses are
 * built from the query results with plain templates, so the same script
 * run on two versions of the code shows whether any address changed:
 *
 *   diff urls-before.txt urls-after.txt
 *
 * collectPublicUrls is also used by src/lib/db/queries.test.ts.
 */
import { loadTestDatabaseEnv } from "@/lib/db/test-database-env";
import { listBrowseYears } from "@/lib/browse-years";
import { buildSitemapEntries } from "@/lib/sitemap-entries";
import { SITE_URL } from "@/lib/site";
import type { PublicExamRecord } from "@/types/domain";

type Queries = typeof import("@/lib/db/queries");

export async function collectPublicUrls(queries: Queries): Promise<string[]> {
  const urls = new Set<string>();
  const series = await queries.listExamSeries();
  const years = listBrowseYears();
  const records = await queries.searchPublicArtifacts({});

  for (const entry of buildSitemapEntries(series, records, years)) {
    urls.add(`sitemap ${entry.url.slice(SITE_URL.length) || "/"}`);
  }

  urls.add("link /browse");
  for (const s of series) {
    urls.add(`link /browse/${s.code}`);
    for (const year of years) {
      urls.add(`link /browse/${s.code}/${year}`);
      for (const subject of await queries.listPublicSubjectsForInstance(s.code, year)) {
        urls.add(`link /browse/${s.code}/${year}/${subject.slug}`);
      }
    }
  }

  function addPaper(r: PublicExamRecord) {
    urls.add(`link /exams/${r.examSeriesCode}/${r.year}/${r.subjectSlug}/${r.slug}`);
    urls.add(`link /browse/${r.examSeriesCode}/${r.year}/${r.subjectSlug}`);
  }
  const subjectsSeen = new Set<string>();
  for (const r of records) {
    addPaper(r);
    const key = `${r.examSeriesCode}/${r.subjectSlug}`;
    if (subjectsSeen.has(key)) continue;
    subjectsSeen.add(key);
    // What a paper page lists for its subject: other years, previous/next.
    for (const other of await queries.listSubjectArtifacts(r.examSeriesCode, r.subjectSlug)) addPaper(other);
  }

  return [...urls].sort();
}

async function main() {
  loadTestDatabaseEnv();
  process.env.DB_POOL_PROFILE = "cli";
  process.env.STORAGE_BACKEND = "local";
  const queries = await import("@/lib/db/queries");
  const { closePool } = await import("@/lib/db/client");
  try {
    for (const url of await collectPublicUrls(queries)) console.log(url);
  } finally {
    await closePool();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/public-urls.ts")) void main();
