/**
 * Tests the safety check that stops the database tests from ever running
 * against the real database. Uses throwaway .env files in a temp folder --
 * no database connection needed.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadTestDatabaseEnv } from "./test-database-env";

const PRODUCTION_ENV = [
  "DATABASE_URL=postgresql://u:p@ep-real-123.ap-southeast-2.aws.neon.tech/db?sslmode=require",
  "DATABASE_URL_POOLED=postgresql://u:p@ep-real-123-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require",
].join("\n");

let dir: string;
let files: { testEnvFile: string; productionEnvFile: string };
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sipp-test-db-env-"));
  files = { testEnvFile: path.join(dir, ".env.test.local"), productionEnvFile: path.join(dir, ".env.local") };
  writeFileSync(files.productionEnvFile, PRODUCTION_ENV);
  savedEnv = { ...process.env };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = savedEnv;
});

test("refuses to run when .env.test.local is missing", () => {
  assert.throws(() => loadTestDatabaseEnv(files), /not found/);
});

test("refuses to run when .env.test.local has no DATABASE_URL_POOLED", () => {
  writeFileSync(files.testEnvFile, "SOMETHING_ELSE=1\n");
  assert.throws(() => loadTestDatabaseEnv(files), /no DATABASE_URL_POOLED/);
});

test("refuses to run when the test database is the production database", () => {
  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-real-123-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  assert.throws(() => loadTestDatabaseEnv(files), /same database/);
});

test("refuses even when it's the production endpoint's direct (unpooled) host", () => {
  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-real-123.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  assert.throws(() => loadTestDatabaseEnv(files), /same database/);
});

test("without .env.local, PRODUCTION_DATABASE_HOST names the real database (as in CI)", () => {
  rmSync(files.productionEnvFile);
  delete process.env.PRODUCTION_DATABASE_HOST;
  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-real-123-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  assert.throws(() => loadTestDatabaseEnv(files), /can't tell which database is the real one/);

  process.env.PRODUCTION_DATABASE_HOST = "ep-real-123.ap-southeast-2.aws.neon.tech";
  assert.throws(() => loadTestDatabaseEnv(files), /same database/);

  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-branch-456-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  loadTestDatabaseEnv(files);
  assert.match(process.env.DATABASE_URL_POOLED ?? "", /ep-branch-456/);
});

test("uses the branch database, overriding any connection string already in the environment", () => {
  const branchUrl = "postgresql://u:p@ep-branch-456-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require";
  writeFileSync(files.testEnvFile, `DATABASE_URL_POOLED=${branchUrl}\n`);
  process.env.DATABASE_URL_POOLED = "postgresql://u:p@ep-real-123-pooler.ap-southeast-2.aws.neon.tech/db";
  process.env.DATABASE_URL = "postgresql://u:p@ep-real-123.ap-southeast-2.aws.neon.tech/db";

  loadTestDatabaseEnv(files);

  assert.equal(process.env.DATABASE_URL_POOLED, branchUrl);
  assert.equal(process.env.DATABASE_URL, undefined);
});

test("refuses to run if any R2 settings are in the environment", () => {
  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-branch-456-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  process.env.R2_BUCKET_NAME = "sipastpapers";
  assert.throws(() => loadTestDatabaseEnv(files), /R2 settings are present in the environment \(R2_BUCKET_NAME\)/);
});

test("forces local file storage", () => {
  writeFileSync(
    files.testEnvFile,
    "DATABASE_URL_POOLED=postgresql://u:p@ep-branch-456-pooler.ap-southeast-2.aws.neon.tech/db?sslmode=require\n"
  );
  process.env.STORAGE_BACKEND = "r2";
  loadTestDatabaseEnv(files);
  assert.equal(process.env.STORAGE_BACKEND, "local");
});
