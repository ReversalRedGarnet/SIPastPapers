/** Which pages the sitemap lists -- pure, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSitemapEntries } from "./sitemap-entries";
import { SITE_URL } from "./site";
import type { ExamSeries, PublicExamRecord } from "@/types/domain";

const SERIES: ExamSeries[] = [
  { id: "1", code: "sisc-l1", name: "SISC Level 1", description: null },
  { id: "2", code: "sif3-sijsc", name: "SIF3 / SIJSC", description: null },
];

function record(year: number, slug: string, withFile: boolean): PublicExamRecord {
  return {
    id: `${year}-${slug}`,
    slug,
    examSeriesCode: "sisc-l1",
    examSeriesName: "SISC Level 1",
    subjectSlug: "mathematics",
    subject: "Mathematics",
    year,
    artifactType: "question_paper",
    paperNumber: null,
    title: "t",
    status: withFile ? "published" : "not_yet_recovered",
    verification: "source_verified",
    rights: "permission_granted",
    file: withFile ? { id: "f", sha256: "0".repeat(64), mime: "application/pdf", bytes: 1 } : null,
    source: null,
  };
}

test("only exam levels, years and subjects with a downloadable paper are listed", () => {
  const urls = buildSitemapEntries(
    SERIES,
    [record(2019, "question-paper", true), record(2020, "question-paper", false)],
    [2019, 2020, 2021]
  ).map((e) => e.url.replace(SITE_URL, ""));

  assert.deepEqual(urls, [
    "",
    "/about",
    "/browse",
    "/browse/sisc-l1",
    "/browse/sisc-l1/2019",
    "/browse/sisc-l1/2019/mathematics",
    "/exams/sisc-l1/2019/mathematics/question-paper",
  ]);
});

test("the sitemap names the www address, not the bare domain that redirects to it", () => {
  if (process.env.NEXT_PUBLIC_SITE_URL) return; // overridden for this run
  assert.equal(SITE_URL, "https://www.sipastexams.com");
});
