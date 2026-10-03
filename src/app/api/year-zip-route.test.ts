/**
 * The /api/download-year/[series]/[year] route with prebuilt zips: 503
 * until the year's zip is built, the zip once it is, never a zip that
 * doesn't match the year's current papers, and unpublish deleting the
 * year's zips. Local storage in a temp folder; a test database branch.
 *
 * Lives outside the [bracket] route folders for the same reason as
 * files/route.test.ts (Node's test runner reads "[...]" as a glob).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { loadTestDatabaseEnv } from "@/lib/db/test-database-env";
import { withRolledBackTransaction, closePool } from "@/lib/db/client";
import { resetRateLimitsForTests } from "@/lib/rate-limit";

let queries: typeof import("@/lib/db/queries");
let getStorageProvider: typeof import("@/lib/storage").getStorageProvider;
let zipBuild: typeof import("@/lib/year-zip-build");
let zipGET: typeof import("./download-year/[series]/[year]/route").GET;
let tmpStorageDir: string;

before(async () => {
  // Connects to the separate test database in .env.test.local, and refuses
  // to run if that's the real database -- see test-database-env.ts.
  loadTestDatabaseEnv();
  process.env.STORAGE_BACKEND = "local";
  process.env.DB_POOL_PROFILE = "cli";
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-year-zip-route-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  queries = await import("@/lib/db/queries");
  ({ getStorageProvider } = await import("@/lib/storage"));
  zipBuild = await import("@/lib/year-zip-build");
  ({ GET: zipGET } = await import("./download-year/[series]/[year]/route"));
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

function getZip(accept = "application/json") {
  return zipGET(
    new NextRequest(`http://localhost/api/download-year/${SERIES}/${YEAR}`, {
      headers: { accept, "x-forwarded-for": "203.0.113.50" },
    }),
    { params: Promise.resolve({ series: SERIES, year: String(YEAR) }) }
  );
}

async function publishPaper(paperNo: string) {
  const { artifactId } = await queries.ingestArtifact({
    examSeriesCode: SERIES,
    year: YEAR,
    subjectSlug: "mathematics",
    artifactType: "question_paper",
    paperNo,
    file: { buffer: Buffer.from(`%PDF-1.4\n%year-zip-route-${paperNo}\n`), mime: "application/pdf" },
  });
  await queries.approveRights(artifactId, {
    basis: "teacher-verified",
    approvedBy: "Test Verifier",
    evidenceUri: `file://evidence/year-zip-route-${paperNo}.pdf`,
  });
  const published = await queries.publishArtifact(artifactId);
  assert.ok(!("missing" in published), "test paper should publish");
  return artifactId;
}

async function buildZip() {
  const status = await zipBuild.getYearZipStatus(getStorageProvider(), SERIES, YEAR);
  await zipBuild.syncYearZip(getStorageProvider(), status);
  return status;
}

test("until the year's zip is built: 503 with a clear message, logged, and not counted against the visitor", async () => {
  await withRolledBackTransaction(async () => {
    resetRateLimitsForTests();
    await publishPaper("31");

    // More tries than the zip allowance (3) -- none of them count.
    for (let i = 0; i < 5; i++) {
      const response = await getZip();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
      assert.ok(Number(response.headers.get("Retry-After")) > 0);
      assert.match((await response.json()).error, /isn't ready yet/);
    }
    const page = await getZip("text/html");
    assert.equal(page.status, 503);
    assert.match(await page.text(), /isn&#39;t ready yet[\s\S]*opened one at a time/);

    await buildZip();
    const ok = await getZip();
    assert.equal(ok.status, 200, "still within the allowance: the 503s weren't counted");
    await ok.body?.cancel();
  });
});

test("a built zip is handed out with its download name, and is exactly the stored zip", async () => {
  await withRolledBackTransaction(async () => {
    resetRateLimitsForTests();
    await publishPaper("32");
    const status = await buildZip();

    const response = await getZip();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/zip");
    assert.match(response.headers.get("Content-Disposition") ?? "", /^attachment; filename="Form 5 - Year 11 2099\.zip"/);
    const body = Buffer.from(await response.arrayBuffer());
    assert.ok(body.equals((await getStorageProvider().get(status.key!))!));
  });
});

test("after a paper is added, the year's old zip is never handed out -- 503 until rebuilt", async () => {
  await withRolledBackTransaction(async () => {
    resetRateLimitsForTests();
    await publishPaper("33");
    const first = await buildZip();
    await publishPaper("34");

    const response = await getZip();
    assert.equal(response.status, 503, "the stored zip no longer matches the year's papers");
    assert.equal(await getStorageProvider().exists(first.key!), true, "it's still stored, just not served");

    const rebuilt = await buildZip();
    assert.notEqual(rebuilt.key, first.key);
    assert.deepEqual(await getStorageProvider().list(`zips/${SERIES}/${YEAR}/`), [rebuilt.key], "old zip deleted");
    const ok = await getZip();
    assert.equal(ok.status, 200);
    await ok.body?.cancel();
  });
});

test("unpublish deletes the year's zips at once, so a withdrawn paper can't be downloaded inside one", async () => {
  await withRolledBackTransaction(async () => {
    resetRateLimitsForTests();
    const kept = await publishPaper("35");
    const withdrawn = await publishPaper("36");
    await buildZip();

    const result = await queries.unpublishArtifact(withdrawn, "withdrawn", "test");
    assert.equal(result.zipsDeleted, 1);
    assert.deepEqual(await getStorageProvider().list(`zips/${SERIES}/${YEAR}/`), []);
    assert.equal((await getZip()).status, 503, "the year still has a paper, but no zip until rebuilt");

    await buildZip();
    const ok = await getZip();
    assert.equal(ok.status, 200);
    await ok.body?.cancel();

    await queries.unpublishArtifact(kept, "withdrawn", "test");
    assert.equal((await getZip()).status, 404, "nothing left to download for this year");
  });
});
