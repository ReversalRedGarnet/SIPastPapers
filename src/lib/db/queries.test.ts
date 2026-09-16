/**
 * Covers the publish safeguard added alongside the CLI (PROJECT_SPEC.md
 * section 11.1/11.2): publish must refuse until the artifact's rights
 * record has basis, approved_by and evidence_uri all set via
 * approveRights, and must succeed once they are.
 *
 * Runs against the real (live Neon) Postgres database, but every test body
 * is wrapped in withRolledBackTransaction (src/lib/db/client.ts), which
 * always rolls back at the end — so nothing here is ever actually
 * committed, no matter how many times this suite runs. This requires
 * `npm run db:migrate` to have been run at least once against the target
 * database already (for the schema + seeded reference data — see
 * migrations/README.md); it does not require or use a separate test
 * database. Storage still writes to an isolated temp directory via
 * SIPASTPAPERS_STORAGE_ROOT, same as before.
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
  // Force local storage regardless of whatever STORAGE_BACKEND is set to
  // for real usage in .env.local (e.g. "r2") — this suite only needs
  // DATABASE_URL_POOLED from that file, and must never touch real R2.
  process.env.STORAGE_BACKEND = "local";
  // Same patient connection budget as the CLI (see src/lib/db/client.ts's
  // getRetryBudget()) — this is a batch test run, not a live page load, so
  // it should ride out a slow Neon cold-start rather than fail fast.
  process.env.DB_POOL_PROFILE = "cli";
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-queries-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  queries = await import("@/lib/db/queries");
});

after(async () => {
  try {
    rmSync(tmpStorageDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
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

    // approveRights requires basis/approvedBy/evidenceUri together, so
    // simulate a partially-resolved rights record the way a real one could
    // exist mid-review (e.g. evidence not yet attached) by approving fully
    // and then knocking one field back out.
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
