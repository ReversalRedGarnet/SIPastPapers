/**
 * Proves that nothing stored under quarantine/ is ever handed out: not by
 * the file route, not in a year's zip, and not listed in the sitemap --
 * both after a normal unpublish, and in the "should never happen" state of
 * a paper still marked published while its file record points into
 * quarantine (see NO_QUARANTINED_FILES in src/lib/db/queries.ts).
 *
 * Lives outside the [bracket] route folders for the same reason as
 * route.test.ts (Node's test runner reads "[...]" in a path as a glob).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { loadTestDatabaseEnv } from "@/lib/db/test-database-env";
import { query, withRolledBackTransaction, closePool } from "@/lib/db/client";
import { artifactSlug } from "@/lib/artifact-naming";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { buildSitemapEntries } from "@/lib/sitemap-entries";

let queries: typeof import("@/lib/db/queries");
let getStorageProvider: typeof import("@/lib/storage").getStorageProvider;
let fileGET: typeof import("./files/[fileId]/route").GET;
let zipGET: typeof import("./download-year/[series]/[year]/route").GET;
let getYearZipStatus: typeof import("@/lib/year-zip-build").getYearZipStatus;
let syncYearZip: typeof import("@/lib/year-zip-build").syncYearZip;
let tmpStorageDir: string;

before(async () => {
  // Connects to the separate test database in .env.test.local, and refuses
  // to run if that's the real database -- see test-database-env.ts.
  loadTestDatabaseEnv();
  process.env.STORAGE_BACKEND = "local";
  process.env.DB_POOL_PROFILE = "cli";
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-quarantine-serving-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  queries = await import("@/lib/db/queries");
  ({ getStorageProvider } = await import("@/lib/storage"));
  ({ GET: fileGET } = await import("./files/[fileId]/route"));
  ({ GET: zipGET } = await import("./download-year/[series]/[year]/route"));
  ({ getYearZipStatus, syncYearZip } = await import("@/lib/year-zip-build"));
});

after(async () => {
  try {
    rmSync(tmpStorageDir, { recursive: true, force: true });
  } catch {
    // It's fine if this cleanup step fails — it's just tidying up a temp folder.
  }
  await closePool();
});

const SERIES = "sisc-l1";
const YEAR = 2099;
const SUBJECT = "mathematics";

/** What each public surface hands out for one paper right now. */
async function served(fileId: string, pageUrlPath: string) {
  resetRateLimitsForTests();
  const file = await fileGET(new NextRequest(`http://localhost/api/files/${fileId}`), {
    params: Promise.resolve({ fileId }),
  });
  await file.body?.cancel();

  // Build (or clear out) the year's zip from what's servable right now, as
  // the operator does with build-zips after any change -- so "zip: 200"
  // means a built zip is handed out, and 404 that the year has nothing
  // that may be served (any old zip is deleted here).
  await syncYearZip(getStorageProvider(), await getYearZipStatus(getStorageProvider(), SERIES, YEAR));
  const zip = await zipGET(new NextRequest(`http://localhost/api/download-year/${SERIES}/${YEAR}`), {
    params: Promise.resolve({ series: SERIES, year: String(YEAR) }),
  });
  // Read the whole zip (it's tiny) so its stream finishes before the test moves on.
  if (zip.status === 200) await zip.arrayBuffer();
  else await zip.body?.cancel();

  const sitemap = buildSitemapEntries(
    await queries.listExamSeries(),
    await queries.searchPublicArtifacts({}),
    [YEAR]
  );
  return {
    file: file.status,
    zip: zip.status,
    sitemap: sitemap.some((e) => e.url.endsWith(pageUrlPath)),
  };
}

async function publishPaper(paperNo: string) {
  const { artifactId } = await queries.ingestArtifact({
    examSeriesCode: SERIES,
    year: YEAR,
    subjectSlug: SUBJECT,
    artifactType: "question_paper",
    paperNo,
    file: { buffer: Buffer.from(`%PDF-1.4\n%quarantine-serving-${paperNo}\n`), mime: "application/pdf" },
  });
  await queries.approveRights(artifactId, {
    basis: "teacher-verified",
    approvedBy: "Test Verifier",
    evidenceUri: `file://evidence/quarantine-serving-${paperNo}.pdf`,
  });
  const published = await queries.publishArtifact(artifactId);
  assert.ok(!("missing" in published), "test paper should publish");
  const [file] = await query<{ id: string; storage_key: string }>(
    "select id, storage_key from files where artifact_id = $1",
    [artifactId]
  );
  const pagePath = `/exams/${SERIES}/${YEAR}/${SUBJECT}/${artifactSlug({ artifactType: "question_paper", paperNo })}`;
  return { artifactId, file, pagePath };
}

test("a published paper whose file record points into quarantine is served nowhere", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishPaper("21");
    assert.deepEqual(await served(paper.file.id, paper.pagePath), { file: 200, zip: 200, sitemap: true }, "baseline");

    // The bad state: still "published", rights fine, and the bytes really
    // are stored at the quarantine key -- so only the quarantine rule
    // itself can be what stops them being served.
    const quarantineKey = queries.quarantineKeyFor(paper.file.storage_key);
    await getStorageProvider().copy(paper.file.storage_key, quarantineKey);
    await query("update files set storage_key = $1 where id = $2", [quarantineKey, paper.file.id]);

    assert.deepEqual(await served(paper.file.id, paper.pagePath), { file: 404, zip: 404, sitemap: false });
    assert.equal(await queries.getFileForDownload(paper.file.id), undefined);
  });
});

test("after unpublish, the quarantined file is served nowhere; after publishing again, it's served from its original key", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishPaper("22");
    await queries.unpublishArtifact(paper.artifactId, "withdrawn", "test");
    assert.deepEqual(await served(paper.file.id, paper.pagePath), { file: 404, zip: 404, sitemap: false });

    await queries.publishArtifact(paper.artifactId);
    assert.deepEqual(await served(paper.file.id, paper.pagePath), { file: 200, zip: 200, sitemap: true });
    assert.equal((await queries.getFileForDownload(paper.file.id))?.storageKey, paper.file.storage_key);
  });
});
