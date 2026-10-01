import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Used only by the test suite. Points the database connection at a
 * separate test database (a Neon branch), never the real one.
 *
 * The test database's connection string lives in `.env.test.local`
 * (gitignored, like every .env file except .env.example):
 *
 *   DATABASE_URL_POOLED=postgresql://...@ep-<branch-endpoint>-pooler.<region>.aws.neon.tech/...
 *
 * As a safety check, this refuses to run at all -- throwing before any
 * test can connect -- if that file is missing, or if it points at the same
 * database server as `.env.local` (the real database, used by the site and
 * the CLI). Tests insert rows inside transactions that are always rolled
 * back, but a bug in a test should never be able to touch real data.
 */

interface TestDatabaseEnvFiles {
  testEnvFile?: string;
  productionEnvFile?: string;
}

function readEnvFile(file: string): Record<string, string | undefined> {
  // `parseEnv` reads .env-style "NAME=value" text into an object WITHOUT
  // adding anything to process.env -- unlike process.loadEnvFile, which
  // the tests used to call on .env.local.
  return parseEnv(readFileSync(file, "utf8"));
}

/**
 * Neon gives each database branch its own endpoint (the `ep-...` part of
 * the host). The pooled and direct connection strings for the same
 * endpoint differ only by a "-pooler" suffix, so that's dropped here to
 * compare like with like.
 */
function endpointHost(connectionString: string): string {
  return new URL(connectionString).hostname.toLowerCase().replace("-pooler", "");
}

export function loadTestDatabaseEnv({
  testEnvFile = ".env.test.local",
  productionEnvFile = ".env.local",
}: TestDatabaseEnvFiles = {}): void {
  if (!existsSync(testEnvFile)) {
    throw new Error(
      `Refusing to run database tests: ${testEnvFile} not found. Create it with ` +
        `DATABASE_URL_POOLED set to a Neon *branch's* pooled connection string (never the real database).`
    );
  }

  const testUrl = readEnvFile(testEnvFile).DATABASE_URL_POOLED;
  if (!testUrl) {
    throw new Error(`Refusing to run database tests: ${testEnvFile} has no DATABASE_URL_POOLED.`);
  }

  if (existsSync(productionEnvFile)) {
    const productionEnv = readEnvFile(productionEnvFile);
    const productionHosts = [productionEnv.DATABASE_URL, productionEnv.DATABASE_URL_POOLED]
      .filter((url): url is string => Boolean(url))
      .map(endpointHost);
    if (productionHosts.includes(endpointHost(testUrl))) {
      throw new Error(
        `Refusing to run database tests: ${testEnvFile} points at the same database (${endpointHost(testUrl)}) ` +
          `as ${productionEnvFile}. Use a separate Neon branch for tests.`
      );
    }
  }

  // Set explicitly (overwriting anything inherited from the shell) so the
  // test database is the only one the connection pool can see.
  process.env.DATABASE_URL_POOLED = testUrl;
  delete process.env.DATABASE_URL;
}
