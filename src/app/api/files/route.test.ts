/**
 * Tests the /api/files/[fileId] route handler itself (not just the query
 * layer underneath it, which src/lib/db/queries.test.ts already covers) --
 * confirming that a paper taken back down (withdrawn) is actually refused
 * with a real HTTP 404 at the route, not just internally.
 *
 * Deliberately lives one level up, outside the [fileId] folder: Node's
 * test runner treats a file path given on the command line as a glob
 * pattern, and "[fileId]" is glob syntax (a character class) that matches
 * nothing literal — a file inside that folder silently registers zero
 * tests when run via `npm test`. The import below still reaches into
 * that folder for the route module itself, which is plain module
 * resolution, not glob matching, so it works fine.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { query, withRolledBackTransaction, closePool } from "@/lib/db/client";

let queries: typeof import("@/lib/db/queries");
let GET: typeof import("./[fileId]/route").GET;
let tmpStorageDir: string;

before(async () => {
  if (existsSync(".env.local")) {
    process.loadEnvFile(".env.local");
  }
  process.env.STORAGE_BACKEND = "local";
  process.env.DB_POOL_PROFILE = "cli";
  tmpStorageDir = mkdtempSync(path.join(tmpdir(), "sipp-files-route-test-storage-"));
  process.env.SIPASTPAPERS_STORAGE_ROOT = tmpStorageDir;
  queries = await import("@/lib/db/queries");
  ({ GET } = await import("./[fileId]/route"));
});

after(async () => {
  try {
    rmSync(tmpStorageDir, { recursive: true, force: true });
  } catch {
    // It's fine if this cleanup step fails — it's just tidying up a temp folder.
  }
  await closePool();
});

test("GET /api/files/[fileId] returns 404 for a withdrawn paper's file", async () => {
  await withRolledBackTransaction(async () => {
    const { artifactId } = await queries.ingestArtifact({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "mathematics",
      artifactType: "question_paper",
      paperNo: "9",
      file: { buffer: Buffer.from("%PDF-1.4\n%route-test\n"), mime: "application/pdf" },
    });

    await queries.approveRights(artifactId, {
      basis: "teacher-verified",
      approvedBy: "Test Verifier",
      evidenceUri: "file://evidence/9.pdf",
    });
    await queries.publishArtifact(artifactId);
    await queries.unpublishArtifact(artifactId, "withdrawn", "test cleanup");

    const [fileRow] = await query<{ id: string }>("select id from files where artifact_id = $1", [artifactId]);

    const request = new NextRequest(`http://localhost/api/files/${fileRow.id}`);
    const response = await GET(request, { params: Promise.resolve({ fileId: fileRow.id }) });

    assert.equal(response.status, 404, "a withdrawn paper's file should 404 at the HTTP layer");
  });
});

test("GET /api/files/[fileId] returns 404 for an id that doesn't exist at all", async () => {
  const request = new NextRequest("http://localhost/api/files/00000000-0000-0000-0000-000000000000");
  const response = await GET(request, {
    params: Promise.resolve({ fileId: "00000000-0000-0000-0000-000000000000" }),
  });
  assert.equal(response.status, 404);
});
