/**
 * Covers scripts/cli-lib.ts: the --basis enum validator, and the batch
 * ingest resilience fix (PROJECT_SPEC.md section 14.2, 2026-09-12) — one
 * corrupt/invalid file must not abort the rest of the batch.
 *
 * The batch-ingest test runs against the real (live Neon) Postgres
 * database, wrapped in withRolledBackTransaction (src/lib/db/client.ts) so
 * nothing it writes is ever actually committed — see the longer
 * explanation in src/lib/db/queries.test.ts. Storage still writes to an
 * isolated temp directory via SIPASTPAPERS_STORAGE_ROOT.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BASIS_CHOICES, isValidBasis } from "./cli-lib";

test("isValidBasis accepts every documented choice", () => {
  for (const choice of BASIS_CHOICES) {
    assert.equal(isValidBasis(choice), true, `expected "${choice}" to be valid`);
  }
});

test("isValidBasis rejects values outside the fixed enum", () => {
  for (const bogus of ["institutional", "MEHRD", "", "teacher_verified", "Teacher-Verified"]) {
    assert.equal(isValidBasis(bogus), false, `expected "${bogus}" to be rejected`);
  }
});

let tmpStorageDir: string;
let tmpFilesDir: string;

before(() => {
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
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-cli-lib-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  tmpFilesDir = mkdtempSync(path.join(tmpdir(), "sipp-cli-lib-test-files-"));
});

after(async () => {
  for (const dir of [tmpStorageDir, tmpFilesDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
  const { closePool } = await import("@/lib/db/client");
  await closePool();
});

test("batch ingest continues past a corrupt file instead of aborting", async () => {
  writeFileSync(path.join(tmpFilesDir, "question-paper_1.pdf"), "%PDF-1.4\n%valid one\n");
  writeFileSync(path.join(tmpFilesDir, "question-paper_2.pdf"), "this is not a pdf");
  writeFileSync(path.join(tmpFilesDir, "marking-scheme_1.pdf"), "%PDF-1.4\n%valid two\n");
  writeFileSync(path.join(tmpFilesDir, "notes.txt"), "ignored, not a pdf at all");

  const { ingestDirectory } = await import("./cli-lib");
  const { listAllArtifacts } = await import("@/lib/db/queries");
  const { withRolledBackTransaction } = await import("@/lib/db/client");

  await withRolledBackTransaction(async () => {
    // Silence progress logging for this test; the CLI still logs by default.
    const summary = await ingestDirectory(
      tmpFilesDir,
      { series: "sisc-l1", year: 2099, subject: "english", source: null, sourceUrl: null, attribution: null },
      () => {}
    );

    assert.equal(summary.ingested, 2, "the two valid PDFs should have been ingested");
    assert.equal(summary.failed, 1, "the corrupt PDF should be counted as failed, not thrown");
    assert.equal(summary.skipped, 0, "no file here has an unparseable filename");

    const artifacts = await listAllArtifacts();
    const ingestedThisRun = artifacts.filter((a) => a.year === 2099);
    assert.equal(ingestedThisRun.length, 2, "the batch loop must not have stopped after the corrupt file");
  });
});
