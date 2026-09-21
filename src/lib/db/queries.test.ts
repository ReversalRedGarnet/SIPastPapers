/**
 * Tests the "publishing safety check": a paper can't be published until
 * its rights record has all three of basis, approved_by, and evidence_uri
 * filled in via approveRights — and it should succeed once they are.
 *
 * These tests run against the real database, but every test is wrapped in
 * withRolledBackTransaction (see src/lib/db/client.ts), which always
 * undoes its changes at the end. So nothing here is ever actually saved
 * for real, no matter how many times these tests run. You do need to have
 * run `npm run db:migrate` at least once against the database beforehand
 * (to set up the tables and basic reference data) — these tests don't use
 * a separate test database. File storage is written to a temporary
 * throwaway folder, as before.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, queryOne, withRolledBackTransaction, closePool } from "./client";
import { artifactSlug } from "@/lib/artifact-naming";
import type { CoverageCell } from "@/lib/db/queries";

let queries: typeof import("@/lib/db/queries");
let tmpStorageDir: string;

before(async () => {
  if (existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
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
});

after(async () => {
  try {
    rmSync(tmpStorageDir, { recursive: true, force: true });
  } catch {
    // It's fine if this cleanup step fails — it's just tidying up a temp folder.
  }
  await closePool();
});

test("publish is refused until basis, approved_by and evidence_uri are all set, then succeeds", async () => {
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
      assert.deepEqual([...beforeApproval.missing].sort(), ["approved_by", "basis", "evidence_uri"]);
    }

    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/1.pdf",
    });

    const afterApproval = await queries.publishArtifact(artifactId);
    assert.ok(!("missing" in afterApproval), "publish should succeed once rights are approved");
    if (!("missing" in afterApproval)) {
      assert.ok(afterApproval.title.length > 0);
    }
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
    // already a real, pre-existing exam_instance (see the tests above) --
    // getCoverageMatrix only ever produces a cell for an exam_instance that
    // actually exists, and this test's own subject never touches 2020, so
    // this is a genuinely empty cell to check, without first having to
    // create the instance itself. The subject still tracks both types
    // (from the 2099 rows above), so this cell should show both as
    // individually missing, not fall back to a single generic "missing"
    // cell that doesn't say which types are absent.
    const cells = await queries.getCoverageMatrix();
    const cell = findCell(cells, "sisc-l1", 2020, subject.slug);

    assert.equal(cell.status, "missing");
    assert.equal(cell.byType.length, 2, "both types this subject tracks should still be listed");
    assert.equal(byType(cell, "question_paper"), "missing");
    assert.equal(byType(cell, "marking_scheme"), "missing");
  });
});
