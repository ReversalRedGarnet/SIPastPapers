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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query, withRolledBackTransaction, closePool } from "./client";

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
