/**
 * Tests the "publishing safety check": a paper can't be published until
 * its rights record has all three of basis, approved_by, and evidence_uri
 * filled in via approveRights — and it should succeed once they are.
 *
 * These tests run against a separate test database -- a Neon branch whose
 * connection string is in .env.test.local -- and refuse to start if that
 * points at the real database (see test-database-env.ts). Every test is
 * also wrapped in withRolledBackTransaction (see src/lib/db/client.ts),
 * which always undoes its changes at the end. The test database needs to
 * have had `npm run db:migrate` run against it once (to set up the tables
 * and basic reference data) -- a branch of the real database already has.
 * File storage is written to a temporary throwaway folder.
 */

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTestDatabaseEnv } from "./test-database-env";
import { query, queryOne, withRolledBackTransaction, closePool } from "./client";
import { createPagePathsSnapshot, judgePath, loadPublicPagePaths } from "./public-paths";
import { artifactSlug } from "@/lib/artifact-naming";
import { listBrowseYears } from "@/lib/browse-years";
import { SITE_URL } from "@/lib/site";
import { buildSitemapEntries } from "@/lib/sitemap-entries";
import { browseSubjectPath, paperPath } from "@/lib/page-links";
import { deriveMissingPaperRows } from "@/lib/missing-papers";
import { adjacentOpenablePapers } from "@/lib/paper-pager";
import { PUBLICLY_VISIBLE } from "./visibility";
import { collectPublicUrls } from "../../../scripts/public-urls";
import type { CoverageCell, FileRelocation } from "@/lib/db/queries";
import type { ArtifactType } from "@/types/domain";
import type { StorageProvider } from "@/lib/storage";
import { fakeR2Storage } from "@/lib/storage/fake-s3-client";
import { pdfServingHeaders } from "@/lib/storage/serving-headers";

let queries: typeof import("@/lib/db/queries");
let getStorageProvider: typeof import("@/lib/storage").getStorageProvider;
let tmpStorageDir: string;

before(async () => {
  // Connects to the separate test database in .env.test.local, and refuses
  // to run if that's the real database -- see test-database-env.ts.
  loadTestDatabaseEnv();
  // Force this test to use local file storage, no matter what's set up
  // for regular use (e.g. cloud storage) — these tests only need the
  // database connection and must never touch real cloud storage.
  process.env.STORAGE_BACKEND = "local";
  // Give the database connection extra patience here, same as the
  // command-line tool — this is a batch test run, not a live page load,
  // so it's fine to wait out a slow database wake-up instead of failing fast.
  process.env.DB_POOL_PROFILE = "cli";
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-queries-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  queries = await import("@/lib/db/queries");
  ({ getStorageProvider } = await import("@/lib/storage"));
});

// Each test's database changes are rolled back, but stored files aren't part
// of that transaction -- so empty the temporary storage folder after every
// test too. Storage refuses to overwrite files, so without this a later test
// ingesting the same paper details (but different bytes) would be refused.
afterEach(() => {
  rmSync(tmpStorageDir, { recursive: true, force: true });
  mkdirSync(tmpStorageDir);
});

after(async () => {
  try {
    rmSync(tmpStorageDir, { recursive: true, force: true });
  } catch {
    // It's fine if this cleanup step fails — it's just tidying up a temp folder.
  }
  await closePool();
});

test("publish is refused until basis, approved_by, evidence_uri and an approved rights status are all in place, then succeeds", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "1",
      file: { buffer: Buffer.from("%PDF-1.4\n%test\n"), mime: "application/pdf" },
    });

    const beforeApproval = await queries.publishArtifact(artifactId);
    assert.ok("missing" in beforeApproval, "publish should be refused before rights are approved");
    if ("missing" in beforeApproval) {
      assert.deepEqual([...beforeApproval.missing].sort(), [
        'an approved rights_status (currently "pending_institutional_approval")',
        "approved_by",
        "basis",
        "evidence_uri",
      ]);
    }

    // approveRights fills in all three fields and sets an approved status
    // (with no expiry date) -- every condition the gate checks.
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/1.pdf",
    });
    assert.deepEqual(await queries.checkRightsGate(artifactId), { satisfied: true, missing: [] });

    const afterApproval = await queries.publishArtifact(artifactId);
    assert.ok(!("missing" in afterApproval), "publish should succeed once rights are approved");
    if (!("missing" in afterApproval)) {
      assert.ok(afterApproval.title.length > 0);
    }
    assert.equal(await queries.getArtifactStatus(artifactId), "published");
  });
});

test("publish is still refused if only some rights fields are set", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "2",
      file: { buffer: Buffer.from("%PDF-1.4\n%test2\n"), mime: "application/pdf" },
    });

    // approveRights normally requires basis, approvedBy, and evidenceUri
    // to all be set together. To test what happens with only some of them
    // set (which can genuinely happen mid-review — e.g. evidence not
    // attached yet), we approve fully first and then remove one field
    // afterwards to simulate that in-between state.
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/2.pdf",
    });

    await query("update rights_records set evidence_uri = null where artifact_id = $1", [artifactId]);

    const result = await queries.publishArtifact(artifactId);
    assert.ok("missing" in result, "publish should be refused when even one rights field is missing");
    if ("missing" in result) {
      assert.deepEqual(result.missing, ["evidence_uri"]);
    }
  });
});

// A freshly-ingested artifact starts out as 'pending_review' (see
// ingestArtifact) and is never touched by publishArtifact in this test —
// so this checks the read side of the same guarantee the two tests above
// check on the write side: a paper that hasn't been published must be
// completely invisible to every public-facing read path, not just
// unreachable via the CLI's publish gate.
test("a pending_review artifact is invisible to every public read path", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "3",
      file: { buffer: Buffer.from("%PDF-1.4\n%test3\n"), mime: "application/pdf" },
    });

    const [fileRow] = await query<{ id: string }>("select id from files where artifact_id = $1", [artifactId]);

    const bySearch = await queries.searchPublicArtifacts({
      series: "sisc-l1",
      year: "2020",
      subject: "mathematics",
    });
    assert.ok(
      !bySearch.some((r) => r.id === artifactId),
      "a pending_review artifact should not appear in public search results"
    );

    const slug = artifactSlug({ artifactType: "question_paper", paperNo: "3" });
    const bySlug = await queries.getPublicArtifactBySlug("sisc-l1", 2020, "mathematics", slug);
    assert.equal(bySlug, undefined, "a pending_review artifact should not be reachable by its public slug");

    const download = await queries.getFileForDownload(fileRow.id);
    assert.equal(download, undefined, "a pending_review artifact's file should not be downloadable");
  });
});

// --- getCoverageMatrix: type-aware coverage cells ---------------------------
//
// A coverage cell used to collapse every artifact type at a given (exam
// instance, subject) down to one status, with 'published' always winning --
// so a published question paper silently hid a missing or not-yet-recovered
// marking scheme for the same cell. These tests check the fix: each cell
// now also carries a `byType` breakdown, one entry per artifact type that
// subject has ever tracked, so the two types can disagree visibly.
//
// Every test here uses its own freshly-inserted subject (a random code/name,
// scoped to the rolled-back transaction) rather than a real subject like
// "mathematics" -- that keeps `byType`'s "every type this subject has ever
// tracked, anywhere in the archive" rule from picking up unrelated real
// artifacts and makes each assertion exact instead of "at least this".

async function insertTestSubject(): Promise<{ id: string; slug: string }> {
  const suffix = randomUUID().slice(0, 8);
  const slug = `coverage-test-${suffix}`;
  const id = randomUUID();
  await query(
    "insert into subjects (id, canonical_name, subject_code) values ($1, $2, $3)",
    [id, `Coverage Test Subject ${suffix}`, slug]
  );
  return { id, slug };
}

async function insertTestSeries(): Promise<{ id: string; code: string }> {
  const suffix = randomUUID().slice(0, 8);
  const code = `coverage-test-series-${suffix}`;
  const id = randomUUID();
  await query(
    "insert into exam_series (id, code, name) values ($1, $2, $3)",
    [id, code, `Coverage Test Series ${suffix}`]
  );
  return { id, code };
}

function findCell(cells: CoverageCell[], seriesCode: string, year: number, subjectSlug: string): CoverageCell {
  const cell = cells.find(
    (c) => c.examSeriesCode === seriesCode && c.year === year && c.subjectSlug === subjectSlug
  );
  assert.ok(cell, `expected a coverage cell for ${seriesCode}/${year}/${subjectSlug}`);
  return cell!;
}

function byType(cell: CoverageCell, type: string) {
  const entry = cell.byType.find((b) => b.type === type);
  assert.ok(entry, `expected a byType entry for ${type} in cell ${cell.subjectSlug}/${cell.year}`);
  return entry!.status;
}

test("coverage cell: published question paper + not_yet_recovered marking scheme shows both, not collapsed to Published", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();

    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: subject.slug,
      artifactType: "question_paper",
      paperNo: null,
      file: { buffer: Buffer.from("%PDF-1.4\n%coverage-a\n"), mime: "application/pdf" },
    });
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/coverage-a.pdf",
    });
    const published = await queries.publishArtifact(artifactId);
    assert.ok(!("missing" in published), "question paper should publish cleanly");

    const instance = await queryOne<{ id: string }>(
      `select ei.id from exam_instances ei join exam_series es on es.id = ei.exam_series_id
       where es.code = $1 and ei.year = $2`,
      ["sisc-l1", 2099]
    );
    assert.ok(instance, "exam instance should exist after ingest");

    // No CLI/queries helper inserts a 'not_yet_recovered' placeholder row
    // (it's a status marker with no file, added directly via SQL when this
    // was done for real -- see PROJECT_SPEC.md's 2026-09-21 entry), so the
    // test does the same thing here.
    await query(
      `insert into artifacts (id, exam_instance_id, subject_id, type, paper_no, title, status, published_at)
       values ($1, $2, $3, 'marking_scheme', null, $4, 'not_yet_recovered', null)`,
      [randomUUID(), instance!.id, subject.id, "Coverage test marking scheme, not yet recovered"]
    );

    const cells = await queries.getCoverageMatrix();
    const cell = findCell(cells, "sisc-l1", 2099, subject.slug);

    assert.equal(cell.status, "published", "collapsed status is unchanged: published still wins overall");
    assert.equal(cell.byType.length, 2, "both tracked types should appear in the breakdown");
    assert.equal(byType(cell, "question_paper"), "published");
    assert.equal(byType(cell, "marking_scheme"), "not_yet_recovered");
  });
});

test("coverage cell: every tracked type published still lists the full per-type breakdown", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();

    for (const artifactType of ["question_paper", "marking_scheme"] as const) {
      const { artifactId } = await queries.ingestArtifact({
        examSeriesCode: "sisc-l1",
        year: 2099,
        subjectSlug: subject.slug,
        artifactType,
        paperNo: null,
        file: { buffer: Buffer.from(`%PDF-1.4\n%coverage-b-${artifactType}\n`), mime: "application/pdf" },
      });
      await queries.approveRights(artifactId, {
        basis: "teacher-verified",
        approvedBy: "Test Verifier",
        evidenceUri: `file://evidence/coverage-b-${artifactType}.pdf`,
      });
      const published = await queries.publishArtifact(artifactId);
      assert.ok(!("missing" in published), `${artifactType} should publish cleanly`);
    }

    const cells = await queries.getCoverageMatrix();
    const cell = findCell(cells, "sisc-l1", 2099, subject.slug);

    assert.equal(cell.status, "published");
    assert.equal(cell.byType.length, 2, "a fully-published multi-type subject still carries both entries");
    assert.equal(byType(cell, "question_paper"), "published");
    assert.equal(byType(cell, "marking_scheme"), "published");
  });
});

test("coverage cell: a year with nothing ingested shows every tracked type as missing, not one collapsed label", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();

    // Publish both types for one year, so this subject tracks two types...
    for (const artifactType of ["question_paper", "marking_scheme"] as const) {
      const { artifactId } = await queries.ingestArtifact({
        examSeriesCode: "sisc-l1",
        year: 2099,
        subjectSlug: subject.slug,
        artifactType,
        paperNo: null,
        file: { buffer: Buffer.from(`%PDF-1.4\n%coverage-c-${artifactType}\n`), mime: "application/pdf" },
      });
      await queries.approveRights(artifactId, {
        basis: "teacher-verified",
        approvedBy: "Test Verifier",
        evidenceUri: `file://evidence/coverage-c-${artifactType}.pdf`,
      });
      await queries.publishArtifact(artifactId);
    }

    // ...then check a different year for the same subject, where nothing
    // at all was ingested. Reuses year 2020 specifically because it's
    // already a real, pre-existing exam_instance (see the tests above), so
    // this exercises the "instance exists, but zero artifacts for this
    // subject" path specifically -- see the next test below for the
    // separate "no exam_instance at all" path. The subject still tracks
    // both types (from the 2099 rows above), so this cell should show both
    // as individually missing, not fall back to a single generic "missing"
    // cell that doesn't say which types are absent.
    const cells = await queries.getCoverageMatrix();
    const cell = findCell(cells, "sisc-l1", 2020, subject.slug);

    assert.equal(cell.status, "missing");
    assert.equal(cell.byType.length, 2, "both types this subject tracks should still be listed");
    assert.equal(byType(cell, "question_paper"), "missing");
    assert.equal(byType(cell, "marking_scheme"), "missing");
  });
});

test("coverage cell: a series/year with zero exam_instances row at all still appears as fully missing", async () => {
  await withRolledBackTransaction(async () => {
    // A brand-new exam_series, guaranteed to have zero exam_instances rows
    // anywhere -- unlike the real series (sisc-l1 etc.), which already
    // have a real row for every year in BROWSE_YEAR_FROM..BROWSE_YEAR_TO,
    // so this is the only reliable way to exercise the "no real instance
    // at all" path getCoverageMatrix() now synthesizes for, rather than
    // the "instance exists but this subject has nothing" path the
    // previous test already covers.
    const series = await insertTestSeries();
    const subject = await insertTestSubject();

    // Publish one year for this series, so the subject tracks a real type...
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: series.code,
      year: 2016,
      subjectSlug: subject.slug,
      artifactType: "question_paper",
      paperNo: null,
      file: { buffer: Buffer.from("%PDF-1.4\n%coverage-d\n"), mime: "application/pdf" },
    });
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/coverage-d.pdf",
    });
    await queries.publishArtifact(artifactId);

    // ...then check a different year for the same brand-new series, one
    // that's never been ingested at all -- no exam_instances row for it
    // exists anywhere. Before this fix, getCoverageMatrix() would have
    // produced no cell at all for it (silently absent, not "missing").
    // 2020 is within BROWSE_YEAR_FROM..BROWSE_YEAR_TO (see browse-years.ts),
    // so it's exactly the range getCoverageMatrix() now synthesizes a
    // virtual instance for.
    const cells = await queries.getCoverageMatrix();
    const cell = findCell(cells, series.code, 2020, subject.slug);

    assert.equal(cell.status, "missing");
    assert.equal(cell.byType.length, 1, "the type this series/subject tracks (from the 2016 row) should still be listed");
    assert.equal(byType(cell, "question_paper"), "missing");
  });
});

test("re-ingesting an existing paper is refused before storage is touched, so its stored file is unchanged", async () => {
  await withRolledBackTransaction(async () => {
    const original = Buffer.from("%PDF-1.4\n%no-overwrite-original\n");
    const { storageKey } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "7",
      file: { buffer: original, mime: "application/pdf" },
    });

    await assert.rejects(
      queries.ingestArtifact({
        examSeriesCode: "sisc-l1",
        year: 2099,
        subjectSlug: "mathematics",
        artifactType: "question_paper",
        paperNo: "7",
        file: { buffer: Buffer.from("%PDF-1.4\n%no-overwrite-rescan\n"), mime: "application/pdf" },
      }),
      /already exists/
    );

    const stored = await getStorageProvider().get(storageKey);
    assert.equal(stored?.toString(), original.toString(), "the original file must not have been replaced");
  });
});

test("an orphaned upload is reused only if it's byte-for-byte the same file", async () => {
  const input = {
    examSeriesCode: "sisc-l1",
    year: 2099,
    subjectSlug: "mathematics",
    artifactType: "question_paper" as const,
    paperNo: "8",
    file: { buffer: Buffer.from("%PDF-1.4\n%orphan\n"), mime: "application/pdf" },
  };

  // The first ingest's database rows are rolled back but its stored file
  // stays -- the same state as an ingest that crashed after uploading.
  const { storageKey } = await withRolledBackTransaction(() => queries.ingestArtifact(input));

  // Re-running the same ingest picks up where it left off...
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact(input);
    assert.ok(artifactId);
  });

  // ...but different bytes at that key are never overwritten.
  await withRolledBackTransaction(async () => {
    await assert.rejects(
      queries.ingestArtifact({ ...input, file: { buffer: Buffer.from("%PDF-1.4\n%different\n"), mime: "application/pdf" } }),
      /Storage already holds a different file/
    );
  });
  const stored = await getStorageProvider().get(storageKey);
  assert.equal(stored?.toString(), input.file.buffer.toString());
});

test("getPublicArtifactPath finds a published paper's page, and nothing for an unpublished one", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "6",
      file: { buffer: Buffer.from("%PDF-1.4\n%report-path\n"), mime: "application/pdf" },
    });
    assert.equal(await queries.getPublicArtifactPath(artifactId), undefined, "pending_review must not be reportable");

    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/report-path.pdf",
    });
    await queries.publishArtifact(artifactId);
    assert.equal(await queries.getPublicArtifactPath(artifactId), "/exams/sisc-l1/2099/mathematics/paper-6");

    assert.equal(await queries.getPublicArtifactPath(randomUUID()), undefined);
  });
});

/**
 * Publishes a fresh 2099 mathematics paper and returns a function that
 * reports which public read paths can currently see it. Rights are changed
 * by updating the paper's one rights row (not adding another): inside a
 * test transaction every row gets the same created_at, so "most recent"
 * would be ambiguous.
 */
async function publishTestPaper(paperNo: string) {
  const { artifactId } = await queries.ingestArtifact({
    examSeriesCode: "sisc-l1",
    year: 2099,
    subjectSlug: "mathematics",
    artifactType: "question_paper",
    paperNo,
    file: { buffer: Buffer.from(`%PDF-1.4\n%rights-invariant-${paperNo}\n`), mime: "application/pdf" },
  });
  await queries.approveRights(artifactId, {
    basis: "teacher-verified",
    approvedBy: "Test Verifier",
    evidenceUri: `file://evidence/rights-invariant-${paperNo}.pdf`,
  });
  const published = await queries.publishArtifact(artifactId);
  assert.ok(!("missing" in published), "test paper should publish");
  const [fileRow] = await query<{ id: string }>("select id from files where artifact_id = $1", [artifactId]);
  const slug = artifactSlug({ artifactType: "question_paper", paperNo });

  async function visibility() {
    const filters = { series: "sisc-l1", year: "2099", subject: "mathematics" };
    const search = await queries.searchPublicArtifacts(filters);
    const results = await queries.searchPublicArtifactsPage(filters, { limit: 100 });
    const recent = await queries.listRecentPublicArtifacts(10_000);
    const zip = await queries.listPublishedFilesForInstance("sisc-l1", 2099);
    return {
      search: search.some((r) => r.id === artifactId),
      results: results.records.some((r) => r.id === artifactId),
      bySlug: (await queries.getPublicArtifactBySlug("sisc-l1", 2099, "mathematics", slug)) !== undefined,
      recent: recent.some((r) => r.id === artifactId),
      zip: zip.some((f) => f.fileId === fileRow.id),
      download: (await queries.getFileForDownload(fileRow.id)) !== undefined,
      reportable: (await queries.getPublicArtifactPath(artifactId)) !== undefined,
    };
  }
  const everywhere = { search: true, results: true, bySlug: true, recent: true, zip: true, download: true, reportable: true };
  const nowhere = { search: false, results: false, bySlug: false, recent: false, zip: false, download: false, reportable: false };
  return { artifactId, visibility, everywhere, nowhere };
}

test("a published paper whose rights are no longer approved disappears from every public read path", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("4");
    assert.deepEqual(await paper.visibility(), paper.everywhere);

    await query("update rights_records set rights_status = 'rights_hold' where artifact_id = $1", [paper.artifactId]);
    assert.deepEqual(await paper.visibility(), paper.nowhere);
  });
});

test("expired rights hide a published paper; rights are still valid on the expiry date itself", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("5");

    await query("update rights_records set expiry_date = current_date where artifact_id = $1", [paper.artifactId]);
    assert.deepEqual(await paper.visibility(), paper.everywhere, "valid through the expiry date");

    await query("update rights_records set expiry_date = current_date - 1 where artifact_id = $1", [paper.artifactId]);
    assert.deepEqual(await paper.visibility(), paper.nowhere, "hidden once the expiry date has passed");
  });
});

test("publish is refused for an unapproved rights status or expired rights, even with every field filled in", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "3",
      file: { buffer: Buffer.from("%PDF-1.4\n%rights-gate\n"), mime: "application/pdf" },
    });
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/rights-gate.pdf",
    });

    await query("update rights_records set rights_status = 'denied' where artifact_id = $1", [artifactId]);
    const denied = await queries.publishArtifact(artifactId);
    assert.ok("missing" in denied && denied.missing.some((m) => m.includes('approved rights_status (currently "denied")')));

    await query(
      "update rights_records set rights_status = 'permission_granted', expiry_date = current_date - 1 where artifact_id = $1",
      [artifactId]
    );
    const expired = await queries.publishArtifact(artifactId);
    assert.ok("missing" in expired && expired.missing.some((m) => m.startsWith("unexpired rights")));

    await query("update rights_records set expiry_date = null where artifact_id = $1", [artifactId]);
    const ok = await queries.publishArtifact(artifactId);
    assert.ok(!("missing" in ok), "publishes once rights are approved and unexpired");
  });
});

test("rights-expiring lists papers expiring within the window, and already-expired (hidden) ones", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("2");
    const find = async (days: number) =>
      (await queries.listPublishedRightsExpiring(days)).find((e) => e.artifactId === paper.artifactId);

    assert.equal(await find(365), undefined, "no expiry date: never listed");

    await query("update rights_records set expiry_date = current_date + 10 where artifact_id = $1", [paper.artifactId]);
    assert.equal((await find(30))?.daysLeft, 10);
    assert.equal(await find(5), undefined, "outside the window");

    await query("update rights_records set expiry_date = current_date - 3 where artifact_id = $1", [paper.artifactId]);
    assert.equal((await find(0))?.daysLeft, -3, "already expired papers are always listed");

    await query("update rights_records set expiry_date = null, rights_status = 'rights_hold' where artifact_id = $1", [
      paper.artifactId,
    ]);
    const unapproved = await queries.listPublishedWithUnapprovedRights();
    assert.equal(unapproved.find((u) => u.artifactId === paper.artifactId)?.rightsStatus, "rights_hold");
  });
});

test("only a paper's current file is served or zipped, never a replaced older version", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("12");
    const [oldFile] = await query<{ id: string }>("select id from files where artifact_id = $1", [paper.artifactId]);

    // A replacement file added later (created_at is set explicitly: inside
    // one test transaction now() never changes).
    const newFileId = randomUUID();
    await query(
      `insert into files (id, artifact_id, storage_key, sha256, mime, bytes, created_at)
       values ($1, $2, 'archive/test/replacement.pdf', repeat('a', 64), 'application/pdf', 10, now() + interval '1 second')`,
      [newFileId, paper.artifactId]
    );

    assert.equal(await queries.getFileForDownload(oldFile.id), undefined, "the old version is no longer served");
    const current = await queries.getFileForDownload(newFileId);
    assert.ok(current, "the current version is served");
    assert.equal(current.bytes, 10, "bigint byte counts come back as numbers, not strings");

    const zip = await queries.listPublishedFilesForInstance("sisc-l1", 2099);
    assert.deepEqual(
      zip.filter((f) => f.fileId === oldFile.id || f.fileId === newFileId).map((f) => f.fileId),
      [newFileId],
      "the zip includes only the current version"
    );
  });
});

test("unpublish moves the paper's file to quarantine (instant revoke), keeps the bytes, and logs it", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("13");
    const [before] = await query<{ id: string; storage_key: string }>(
      "select id, storage_key from files where artifact_id = $1",
      [paper.artifactId]
    );

    const result = await queries.unpublishArtifact(paper.artifactId, "withdrawn", "test");
    assert.equal(result.filesMoved, 1);
    assert.deepEqual(result.moveErrors, []);

    const [after] = await query<{ storage_key: string }>("select storage_key from files where id = $1", [before.id]);
    assert.match(after.storage_key, /^quarantine\/\d{8}T\d{6}\//);
    assert.ok(after.storage_key.endsWith(before.storage_key));
    assert.equal(await getStorageProvider().exists(before.storage_key), false, "the old key no longer resolves");
    assert.match((await getStorageProvider().get(after.storage_key))!.toString(), /rights-invariant-13/);

    const [event] = await query<{ metadata: { from: string; to: string } }>(
      "select metadata from audit_events where object_id = $1 and event_type = 'file_quarantined'",
      [paper.artifactId]
    );
    assert.deepEqual(event.metadata, { fileId: before.id, from: before.storage_key, to: after.storage_key });
  });
});

test("publishing again moves the file back from quarantine to its original key, and logs it", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("14");
    const [file] = await query<{ id: string; storage_key: string }>(
      "select id, storage_key from files where artifact_id = $1",
      [paper.artifactId]
    );
    await queries.unpublishArtifact(paper.artifactId, "withdrawn", "test");
    const [quarantined] = await query<{ storage_key: string }>("select storage_key from files where id = $1", [file.id]);

    const result = await queries.publishArtifact(paper.artifactId);
    assert.ok(!("missing" in result));
    assert.equal(result.filesRestored, 1);

    const [restored] = await query<{ storage_key: string }>("select storage_key from files where id = $1", [file.id]);
    assert.equal(restored.storage_key, file.storage_key, "back at the original key");
    assert.equal(await getStorageProvider().exists(file.storage_key), true);
    assert.equal(await getStorageProvider().exists(quarantined.storage_key), false, "the quarantine copy is gone");
    assert.equal((await queries.getFileForDownload(file.id))?.storageKey, file.storage_key);

    const [event] = await query<{ metadata: unknown }>(
      "select metadata from audit_events where object_id = $1 and event_type = 'file_restored'",
      [paper.artifactId]
    );
    assert.deepEqual(event.metadata, { fileId: file.id, from: quarantined.storage_key, to: file.storage_key });
  });
});

test("on R2, a file quarantined and restored by relocateStoredFile keeps Content-Type, inline Content-Disposition and Cache-Control", async () => {
  await withRolledBackTransaction(async () => {
    // A fake, in-memory R2 bucket -- never the real one (see test-database-env.ts).
    const r2 = fakeR2Storage();
    const move = await relocationFor("23");
    const title = (await queryOne<{ title: string }>("select title from artifacts where id = $1", [move.artifactId]))!.title;
    const headers = pdfServingHeaders(title);
    await r2.put(move.fromKey, (await getStorageProvider().get(move.fromKey))!, headers);

    const out = await queries.relocateStoredFile(r2, move);
    assert.deepEqual(out, { moved: true, leftoverKey: null });
    const back = await queries.relocateStoredFile(r2, {
      ...move,
      fromKey: move.toKey,
      toKey: move.fromKey,
      eventType: "file_restored",
    });
    assert.deepEqual(back, { moved: true, leftoverKey: null });

    const restored = await r2.describe(move.fromKey);
    assert.equal(restored?.contentType, "application/pdf");
    assert.equal(restored?.contentDisposition, headers.contentDisposition);
    assert.match(restored?.contentDisposition ?? "", /^inline; filename=".+\.pdf"; filename\*=UTF-8''/);
    assert.equal(restored?.cacheControl, "private, max-age=600");
    assert.equal(await r2.exists(move.toKey), false, "nothing left in quarantine");
    assert.equal(await recordedKey(move.fileId), move.fromKey);
  });
});

/**
 * The real storage, with some of its methods swapped out -- to make one
 * step of a file move fail on purpose. Object.create keeps every other
 * method (and the real storage's settings) working as normal.
 */
function storageWith(overrides: Partial<StorageProvider>): StorageProvider {
  return Object.assign(Object.create(getStorageProvider()), overrides);
}

/** A published test paper's file, set up for a move to a quarantine key. */
async function relocationFor(paperNo: string): Promise<FileRelocation> {
  const paper = await publishTestPaper(paperNo);
  const [file] = await query<{ id: string; storage_key: string; sha256: string }>(
    "select id, storage_key, sha256 from files where artifact_id = $1",
    [paper.artifactId]
  );
  return {
    fileId: file.id,
    artifactId: paper.artifactId,
    fromKey: file.storage_key,
    toKey: queries.quarantineKeyFor(file.storage_key),
    sha256: file.sha256,
    eventType: "file_quarantined",
  };
}

async function recordedKey(fileId: string): Promise<string> {
  const [row] = await query<{ storage_key: string }>("select storage_key from files where id = $1", [fileId]);
  return row.storage_key;
}

test("a file move whose database update fails leaves the record on the original key, which still exists", async () => {
  await withRolledBackTransaction(async () => {
    const move = await relocationFor("15");
    const outcome = await queries.relocateStoredFile(getStorageProvider(), move, async () => {
      throw new Error("simulated database failure");
    });

    assert.equal(outcome.moved, false);
    assert.equal(await recordedKey(move.fileId), move.fromKey);
    assert.equal(await getStorageProvider().exists(move.fromKey), true, "the key the record points at still exists");
    assert.equal(await getStorageProvider().exists(move.toKey), false, "the half-made copy is cleaned up");
  });
});

test("a file move whose copy fails changes nothing", async () => {
  await withRolledBackTransaction(async () => {
    const move = await relocationFor("16");
    const storage = storageWith({
      copy: async () => {
        throw new Error("simulated storage failure");
      },
    });
    const outcome = await queries.relocateStoredFile(storage, move);

    assert.equal(outcome.moved, false);
    assert.equal(await recordedKey(move.fileId), move.fromKey);
    assert.equal(await getStorageProvider().exists(move.fromKey), true);
  });
});

test("a file move whose final delete fails still points the record at the new key, which exists; retrying is safe", async () => {
  await withRolledBackTransaction(async () => {
    const move = await relocationFor("17");
    const storage = storageWith({
      delete: async () => {
        throw new Error("simulated storage failure");
      },
    });
    const outcome = await queries.relocateStoredFile(storage, move);

    assert.deepEqual(outcome, {
      moved: true,
      leftoverKey: move.fromKey,
      note: "the old copy couldn't be deleted: simulated storage failure",
    });
    assert.equal(await recordedKey(move.fileId), move.toKey);
    assert.equal(await getStorageProvider().exists(move.toKey), true, "the key the record points at exists");

    // Moving it back (as publishing again does) reuses the identical copy
    // still sitting at the original key instead of refusing.
    const back = await queries.relocateStoredFile(getStorageProvider(), {
      ...move,
      fromKey: move.toKey,
      toKey: move.fromKey,
      eventType: "file_restored",
    });
    assert.deepEqual(back, { moved: true, leftoverKey: null });
    assert.equal(await recordedKey(move.fileId), move.fromKey);
    assert.equal(await getStorageProvider().exists(move.toKey), false);
  });
});

test("publishing again is refused -- and nothing is served -- if the file can't be moved back from quarantine", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("18");
    const [file] = await query<{ id: string; storage_key: string }>(
      "select id, storage_key from files where artifact_id = $1",
      [paper.artifactId]
    );
    await queries.unpublishArtifact(paper.artifactId, "withdrawn", "test");
    const quarantinedKey = await recordedKey(file.id);
    // Something different now occupies the original key.
    await getStorageProvider().put(file.storage_key, Buffer.from("%PDF-1.4\n%something else\n"));

    const result = await queries.publishArtifact(paper.artifactId);
    assert.ok("missing" in result && result.missing[0].includes("a different file is already stored at"));
    assert.equal((await queries.getArtifactStatus(paper.artifactId)), "withdrawn", "not published");
    assert.equal(await recordedKey(file.id), quarantinedKey, "still points at its quarantine copy");
    assert.equal(await getStorageProvider().exists(quarantinedKey), true);
    assert.deepEqual(await paper.visibility(), paper.nowhere);
  });
});

test("purge permanently deletes only an unpublished paper's quarantined files, logs each one, and blocks republishing", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("19");
    const [file] = await query<{ id: string; storage_key: string; sha256: string }>(
      "select id, storage_key, sha256 from files where artifact_id = $1",
      [paper.artifactId]
    );
    await assert.rejects(queries.prepareArtifactPurge(paper.artifactId), /is published/);

    await queries.unpublishArtifact(paper.artifactId, "withdrawn", "test");
    const plan = await queries.prepareArtifactPurge(paper.artifactId);
    assert.equal(plan.files.length, 1);
    const quarantinedKey = plan.files[0].storageKey;
    assert.ok(quarantinedKey.startsWith(queries.QUARANTINE_PREFIX));
    assert.equal(await getStorageProvider().exists(quarantinedKey), true, "preparing deletes nothing");

    const result = await queries.purgeArtifactFiles(paper.artifactId, "test purge");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.purged.map((p) => p.storageKey),
      [quarantinedKey]
    );
    assert.equal(await getStorageProvider().exists(quarantinedKey), false);
    assert.equal((await query("select 1 from files where id = $1", [file.id])).length, 0);

    const [event] = await query<{ metadata: Record<string, unknown> }>(
      "select metadata from audit_events where object_id = $1 and event_type = 'file_purged'",
      [paper.artifactId]
    );
    assert.equal(event.metadata.key, quarantinedKey);
    assert.equal(event.metadata.sha256, file.sha256);
    assert.equal(event.metadata.reason, "test purge");

    const again = await queries.publishArtifact(paper.artifactId);
    assert.ok("missing" in again && again.missing.includes("a stored file (none is recorded)"));
  });
});

test("unpublish quarantines a file still left at its original key by an earlier failed move, before purge lists it", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("20");
    const [file] = await query<{ id: string; storage_key: string }>(
      "select id, storage_key from files where artifact_id = $1",
      [paper.artifactId]
    );
    // Unpublished without its file being moved (as if the move had failed).
    await query("update artifacts set status = 'withdrawn' where id = $1", [paper.artifactId]);

    const plan = await queries.prepareArtifactPurge(paper.artifactId);
    assert.equal(plan.quarantine.filesMoved, 1);
    assert.equal(plan.files.length, 1);
    assert.equal(await getStorageProvider().exists(file.storage_key), false);
  });
});

test("search: words are matched separately, with years, exam levels and short forms understood", async () => {
  await withRolledBackTransaction(async () => {
    const paper = await publishTestPaper("41");
    const finds = async (q: string) =>
      (await queries.searchPublicArtifacts({ q })).some((r) => r.id === paper.artifactId);

    for (const q of ["Mathematics 2099", "2099 maths", "maths 2099", "Year 11 maths 2099", "form 5 mathematics 2099", "SISC L1 2099 math", "paper 41 2099", "2099 past papers"]) {
      assert.equal(await finds(q), true, `"${q}" should find it`);
    }
    for (const q of ["form 3 maths 2099", "Year 12 maths 2099", "english 2099", "maths 2098", "paper 42 2099", "2099 marking scheme"]) {
      assert.equal(await finds(q), false, `"${q}" should not find it`);
    }
  });
});

test("search results have a stable order within a year and subject, so pages never repeat or skip papers", async () => {
  await withRolledBackTransaction(async () => {
    const ids = [];
    for (const n of ["43", "42", "44"]) ids.push((await publishTestPaper(n)).artifactId);
    const filters = { series: "sisc-l1", year: "2099", subject: "mathematics" };
    const all = (await queries.searchPublicArtifacts(filters)).map((r) => r.id);
    const paged = [];
    for (let page = 1; page <= 3; page++) {
      paged.push(...(await queries.searchPublicArtifactsPage(filters, { page, limit: 1 })).records.map((r) => r.id));
    }
    assert.deepEqual(paged, all, "one-per-page listing matches the full listing exactly");
    assert.equal(new Set(paged).size, 3);
  });
});

test("the proxy finds a freshly published paper on its first request, without waiting for the 5-minute refresh", async () => {
  await withRolledBackTransaction(async () => {
    // Generous waits: this is a test database, possibly slow to answer.
    const snapshot = createPagePathsSnapshot(loadPublicPagePaths, { firstLoadWaitMs: 120_000, missReloadWaitMs: 120_000 });
    const address = `/exams/sisc-l1/2099/mathematics/${artifactSlug({ artifactType: "question_paper", paperNo: "45" })}`;
    assert.equal(await snapshot.judge("/browse", 0), "exists", "the list is loaded before the paper exists");
    assert.equal(await snapshot.judge(address, 1_000), "missing");

    await publishTestPaper("45");
    assert.equal(await snapshot.judge(address, 31_000), "exists", "found once 30 s have passed since the last reload");
  });
});

test("a not-yet-recovered placeholder given a file is listed only with approved rights, and its file is never shown, served or put in the sitemap", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "46",
      file: { buffer: Buffer.from("%PDF-1.4\n%placeholder-with-file\n"), mime: "application/pdf" },
    });
    await query("update artifacts set status = 'not_yet_recovered' where id = $1", [artifactId]);
    const [fileRow] = await query<{ id: string }>("select id from files where artifact_id = $1", [artifactId]);
    const slug = artifactSlug({ artifactType: "question_paper", paperNo: "46" });
    const address = `/exams/sisc-l1/2099/mathematics/${slug}`;

    async function seen() {
      const filters = { series: "sisc-l1", year: "2099", subject: "mathematics" };
      const search = await queries.searchPublicArtifacts(filters);
      const results = await queries.searchPublicArtifactsPage(filters, { limit: 100 });
      const record = search.find((r) => r.id === artifactId);
      const sitemap = buildSitemapEntries(
        await queries.listExamSeries(),
        await queries.searchPublicArtifacts({}),
        listBrowseYears()
      ).map((e) => e.url);
      return {
        search: record !== undefined,
        results: results.records.some((r) => r.id === artifactId),
        fileShown: Boolean(record?.file),
        bySlug: (await queries.getPublicArtifactBySlug("sisc-l1", 2099, "mathematics", slug)) !== undefined,
        proxy: judgePath(await loadPublicPagePaths(), address) === "exists",
        sitemap: sitemap.includes(`${SITE_URL}${address}`),
        download: (await queries.getFileForDownload(fileRow.id)) !== undefined,
      };
    }
    const hidden = { search: false, results: false, fileShown: false, bySlug: false, proxy: false, sitemap: false, download: false };
    // Listed on browse, but never in the search results page (it can't be opened).
    const listedAsPlaceholder = { ...hidden, search: true, bySlug: true, proxy: true };

    assert.deepEqual(await seen(), hidden, "rights not approved (as ingested): hidden everywhere");

    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/placeholder-with-file.pdf",
    });
    assert.deepEqual(await seen(), listedAsPlaceholder, "approved: listed, but still only as a placeholder");

    await query("update rights_records set expiry_date = current_date - 1 where artifact_id = $1", [artifactId]);
    assert.deepEqual(await seen(), hidden, "rights expired: hidden again");

    await query("delete from files where artifact_id = $1", [artifactId]);
    assert.deepEqual(await seen(), listedAsPlaceholder, "with no file, a placeholder is listed whatever its rights");
  });
});

test("search results list only papers that can be opened: a placeholder is never in a page, a search or the count, but browse and /missing still show it", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();
    const word = subject.slug.replace("coverage-test-", ""); // unique to this subject's name
    const { artifactId: publishedId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2099,
      subjectSlug: subject.slug,
      artifactType: "question_paper",
      paperNo: null,
      file: { buffer: Buffer.from("%PDF-1.4\n%results-openable\n"), mime: "application/pdf" },
    });
    await queries.approveRights(publishedId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/results-openable.pdf",
    });
    assert.ok(!("missing" in (await queries.publishArtifact(publishedId))), "question paper should publish");

    const allBefore = (await queries.searchPublicArtifactsPage({}, { limit: 1 })).total;

    // A placeholder the way the real ones were made (see the coverage tests above).
    const instance = await queryOne<{ id: string }>(
      `select ei.id from exam_instances ei join exam_series es on es.id = ei.exam_series_id
       where es.code = 'sisc-l1' and ei.year = 2099`
    );
    const placeholderId = randomUUID();
    await query(
      `insert into artifacts (id, exam_instance_id, subject_id, type, paper_no, title, status, published_at)
       values ($1, $2, $3, 'marking_scheme', null, 'Results test marking scheme, not yet recovered', 'not_yet_recovered', null)`,
      [placeholderId, instance!.id, subject.id]
    );

    const results = (filters: Parameters<typeof queries.searchPublicArtifactsPage>[0]) =>
      queries.searchPublicArtifactsPage(filters, { limit: 100 });
    const filters = { series: "sisc-l1", year: "2099", subject: subject.slug };

    for (const [label, search, expectedIds] of [
      ["filters", filters, [publishedId]],
      ["search", { q: `${word} 2099` }, [publishedId]],
      ["search matching only the placeholder", { q: `${word} marking scheme` }, []],
    ] as const) {
      const page = await results(search);
      assert.deepEqual(page.records.map((r) => r.id), expectedIds, `${label}: only the openable paper is listed`);
      assert.equal(page.total, expectedIds.length, `${label}: the count leaves the placeholder out too`);
      assert.ok(page.records.every((r) => r.file !== null), `${label}: every row has a file`);
    }
    assert.equal((await queries.searchPublicArtifactsPage({}, { limit: 1 })).total, allBefore, "the unfiltered count is unchanged");

    // The "N matching papers haven't been recovered yet" note counts it.
    assert.equal(await queries.countUnrecoveredMatches({ q: `${word} marking scheme` }), 1);
    assert.equal(await queries.countUnrecoveredMatches(filters), 1);
    assert.equal(await queries.countUnrecoveredMatches({ q: `${word} 2098` }), 0, "no placeholder in that year");

    // Browse still lists it, as a placeholder with no file...
    const browse = await queries.searchPublicArtifacts(filters);
    assert.deepEqual(new Set(browse.map((r) => r.id)), new Set([publishedId, placeholderId]));
    assert.equal(browse.find((r) => r.id === placeholderId)?.file, null);
    const subjects = await queries.listPublicSubjectsForInstance("sisc-l1", 2099);
    assert.equal(subjects.find((s) => s.slug === subject.slug)?.count, 2, "the browse year page counts it");

    // ...and so does /missing.
    const missing = deriveMissingPaperRows(await queries.getCoverageMatrix()).find(
      (r) => r.examSeriesCode === "sisc-l1" && r.year === 2099 && r.subjectSlug === subject.slug
    );
    assert.deepEqual(missing?.missingArtifactTypes, ["marking_scheme"]);
  });
});

/** The sisc-l1 exam instance for `year`, created if this test database has none yet. */
async function examInstanceId(year: number): Promise<string> {
  await query(
    `insert into exam_instances (exam_series_id, year)
     select id, $1 from exam_series where code = 'sisc-l1'
     on conflict (exam_series_id, year) do nothing`,
    [year]
  );
  const row = await queryOne<{ id: string }>(
    `select ei.id from exam_instances ei join exam_series es on es.id = ei.exam_series_id
     where es.code = 'sisc-l1' and ei.year = $1`,
    [year]
  );
  return row!.id;
}

/** A published, openable sisc-l1 paper for a test subject. */
async function publishSubjectPaper(subjectSlug: string, year: number, artifactType: ArtifactType): Promise<string> {
  const { artifactId } = await queries.ingestArtifact({
    examSeriesCode: "sisc-l1",
    year,
    subjectSlug,
    artifactType,
    paperNo: null,
    file: { buffer: Buffer.from(`%PDF-1.4\n%pager-${subjectSlug}-${year}-${artifactType}\n`), mime: "application/pdf" },
  });
  await queries.approveRights(artifactId, {
    basis: "teacher-verified",
    approvedBy: "Test Verifier",
    evidenceUri: `file://evidence/pager-${year}-${artifactType}.pdf`,
  });
  assert.ok(!("missing" in (await queries.publishArtifact(artifactId))), "test paper should publish");
  return artifactId;
}

/** A "not yet recovered" placeholder (no file) for a test subject, made the way the real ones were. */
async function insertPlaceholder(subjectId: string, year: number, artifactType: ArtifactType): Promise<string> {
  const id = randomUUID();
  await query(
    `insert into artifacts (id, exam_instance_id, subject_id, type, paper_no, title, status, published_at)
     values ($1, $2, $3, $4, null, $5, 'not_yet_recovered', null)`,
    [id, await examInstanceId(year), subjectId, artifactType, `Pager test ${artifactType} ${year}, not yet recovered`]
  );
  return id;
}

/** What one paper's page links to: Related papers, and Previous/Next. */
async function paperPageLinks(subjectSlug: string, year: number, artifactType: ArtifactType) {
  const page = await queries.getPublicArtifactBySlug("sisc-l1", year, subjectSlug, artifactSlug({ artifactType, paperNo: null }));
  assert.ok(page, `the ${year} ${artifactType} page should exist`);
  const { prev, next } = adjacentOpenablePapers(await queries.listSubjectArtifacts("sisc-l1", subjectSlug), page!.record.id);
  return { related: page!.related.map((r) => r.id), prev: prev?.id, next: next?.id };
}

test("a paper page never links to a placeholder: Related papers leave it out, and Previous/Next skip to the nearest paper that can be opened", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();
    // In the subject's reading order (year, then type):
    const a = await publishSubjectPaper(subject.slug, 2095, "question_paper");
    const p1 = await insertPlaceholder(subject.id, 2096, "question_paper");
    const p2 = await insertPlaceholder(subject.id, 2097, "marking_scheme");
    const b = await publishSubjectPaper(subject.slug, 2097, "question_paper");
    const p3 = await insertPlaceholder(subject.id, 2098, "question_paper");
    const c = await publishSubjectPaper(subject.slug, 2099, "question_paper");

    assert.deepEqual(await paperPageLinks(subject.slug, 2097, "question_paper"), { related: [], prev: a, next: c });
    // A placeholder's own page still works, and links only to openable papers.
    assert.deepEqual(await paperPageLinks(subject.slug, 2097, "marking_scheme"), { related: [b], prev: a, next: b });

    // "More papers in this subject" is built from the same list, which still has every placeholder.
    const list = await queries.listSubjectArtifacts("sisc-l1", subject.slug);
    assert.deepEqual(
      list.map((r) => [r.id, r.openable]),
      [[a, true], [p1, false], [p2, false], [b, true], [p3, false], [c, true]]
    );
  });
});

test("a paper whose neighbours are all placeholders gets no Previous or Next link, rather than a link to a placeholder", async () => {
  await withRolledBackTransaction(async () => {
    const subject = await insertTestSubject();
    await insertPlaceholder(subject.id, 2096, "question_paper");
    await insertPlaceholder(subject.id, 2097, "marking_scheme");
    await publishSubjectPaper(subject.slug, 2097, "question_paper");
    await insertPlaceholder(subject.id, 2098, "question_paper");

    assert.deepEqual(await paperPageLinks(subject.slug, 2097, "question_paper"), { related: [], prev: undefined, next: undefined });
  });
});

test("search results leave out a published paper whose file record is gone, since it can't be opened either", async () => {
  await withRolledBackTransaction(async () => {
    // Publishing refuses a paper with no file, so this only arises from a
    // hand edit -- but search must still never offer it.
    const paper = await publishTestPaper("47");
    await query("delete from files where artifact_id = $1", [paper.artifactId]);
    const visible = await paper.visibility();
    assert.equal(visible.results, false);
    assert.equal(visible.download, false);
  });
});

test("a subject with no code still gets working page links: none has a null, undefined or empty part, and the proxy knows every one", async () => {
  await withRolledBackTransaction(async () => {
    const series = "sisc-l2-sinf6";
    const year = 2024;
    const subject = await insertTestSubject();
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: series,
      year,
      subjectSlug: subject.slug,
      artifactType: "question_paper",
      paperNo: "1",
      file: { buffer: Buffer.from("%PDF-1.4\n%no-subject-code\n"), mime: "application/pdf" },
    });
    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/no-subject-code.pdf",
    });
    assert.ok(!("missing" in (await queries.publishArtifact(artifactId))), "test paper should publish");
    // Ingesting looks a subject up by its code, so take the code away only now.
    await query("update subjects set subject_code = null where id = $1", [subject.id]);
    const slug = artifactSlug({ artifactType: "question_paper", paperNo: "1" });

    // Every link a public page builds with a subject in it, from the same
    // queries and helpers the pages use.
    const records = [
      ...(await queries.searchPublicArtifacts({})),
      ...(await queries.listRecentPublicArtifacts(10_000)),
      ...(await queries.listSubjectArtifacts(series, subject.id)),
    ];
    const bySlug = await queries.getPublicArtifactBySlug(series, year, subject.id, slug);
    assert.ok(bySlug, "the paper's page is found under the subject's id");
    records.push(bySlug.record, ...bySlug.related);
    const links = [
      ...records.flatMap((r) => [paperPath(r), browseSubjectPath(r.examSeriesCode, r.year, r.subjectSlug)]),
      ...(await queries.listPublicSubjectsForInstance(series, year)).map((s) => browseSubjectPath(series, year, s.slug)),
      ...buildSitemapEntries(await queries.listExamSeries(), records, listBrowseYears())
        .map((e) => e.url.slice(SITE_URL.length))
        .filter((p) => p.startsWith("/browse/") || p.startsWith("/exams/")),
    ];
    const reportPath = await queries.getPublicArtifactPath(artifactId);
    assert.equal(reportPath, `/exams/${series}/${year}/${subject.id}/${slug}`);
    links.push(reportPath);

    assert.ok(links.includes(browseSubjectPath(series, year, subject.id)), "the year page links to the subject");
    const paths = await loadPublicPagePaths();
    for (const link of links) {
      assert.doesNotMatch(link, /\/(null|undefined)?(\/|$)/, `${link} has a null, undefined or empty part`);
      assert.equal(judgePath(paths, link), "exists", `the proxy would answer ${link} with a 404`);
    }
  });
});

test("the subject-slug rule changed no existing public address: every subject with a code is still linked by its code", async () => {
  // The addresses as the pages build them now (scripts/public-urls.ts)...
  const now = await collectPublicUrls(queries);
  const codeless = new Set(
    (await query<{ id: string }>("select id from subjects where subject_code is null")).map((r) => r.id)
  );
  const subjectPart = (line: string) => line.split(" ")[1].split("/")[4];
  const current = (prefix: string, parts: number) =>
    now
      .filter((l) => l.startsWith(`link ${prefix}`) && l.split(" ")[1].split("/").length === parts)
      .filter((l) => !codeless.has(subjectPart(l)))
      .map((l) => l.slice("link ".length));

  // ...against the old rule: the subject part was subject_code itself.
  const rows = await query<{ code: string; year: number; subject_code: string; type: ArtifactType; paper_no: string | null }>(
    `select es.code, ei.year, s.subject_code, a.type, a.paper_no
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join subjects s on s.id = a.subject_id
     where ${PUBLICLY_VISIBLE} and s.subject_code is not null`
  );
  const unique = (xs: string[]) => [...new Set(xs)].sort();
  const oldPapers = unique(
    rows.map((r) => `/exams/${r.code}/${r.year}/${r.subject_code}/${artifactSlug({ artifactType: r.type, paperNo: r.paper_no })}`)
  );
  const oldSubjectPages = unique(rows.map((r) => `/browse/${r.code}/${r.year}/${r.subject_code}`));

  assert.ok(oldPapers.length > 0, "the test database has public papers to compare");
  assert.deepEqual(unique(current("/exams/", 6)), oldPapers);
  assert.deepEqual(unique(current("/browse/", 5)), oldSubjectPages);
});
