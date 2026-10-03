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
 * test can connect -- if that file is missing, if it points at the same
 * database server as `.env.local` (the real database, used by the site and
 * the CLI) or as PRODUCTION_DATABASE_HOST (how CI names the real database),
 * if neither of those is available to compare against, or if any R2_*
 * storage settings are in the environment. It
 * also forces local file storage. Tests insert rows inside transactions
 * that are always rolled back, but a bug in a test should never be able
 * to touch real data or real stored files.
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

  // The real database's endpoint, from .env.local and/or from
  // PRODUCTION_DATABASE_HOST (its host name, e.g. ep-xxx.<region>.aws.neon.tech,
  // or a full connection string) -- the latter is how CI, which has no
  // .env.local, tells this check what to compare against.
  const productionEnv = existsSync(productionEnvFile) ? readEnvFile(productionEnvFile) : {};
  const productionHosts = [productionEnv.DATABASE_URL, productionEnv.DATABASE_URL_POOLED]
    .filter((url): url is string => Boolean(url))
    .map(endpointHost);
  const declaredHost = process.env.PRODUCTION_DATABASE_HOST?.trim();
  if (declaredHost) {
    productionHosts.push(declaredHost.includes("://") ? endpointHost(declaredHost) : endpointHost(`postgresql://${declaredHost}`));
  }
  if (productionHosts.length === 0) {
    throw new Error(
      `Refusing to run database tests: can't tell which database is the real one -- there's no ${productionEnvFile} ` +
        `with its connection strings, and PRODUCTION_DATABASE_HOST isn't set.`
    );
  }
  if (productionHosts.includes(endpointHost(testUrl))) {
    throw new Error(
      `Refusing to run database tests: ${testEnvFile} points at the same database (${endpointHost(testUrl)}) ` +
        `as the real one. Use a separate Neon branch for tests.`
    );
  }

  // Tests must never be able to write to the real file storage bucket.
  // Nothing here loads R2 settings (only DATABASE_URL_POOLED is read from
  // .env.test.local), so if any are present they came from the shell --
  // refuse rather than risk a test reaching the real bucket.
  const r2Variables = Object.keys(process.env).filter((name) => name.startsWith("R2_"));
  if (r2Variables.length > 0) {
    throw new Error(
      `Refusing to run database tests: R2 settings are present in the environment (${r2Variables.join(", ")}). ` +
        `Tests must only ever use local file storage -- unset these first.`
    );
  }
  process.env.STORAGE_BACKEND = "local";

  // Set explicitly (overwriting anything inherited from the shell) so the
  // test database is the only one the connection pool can see.
  process.env.DATABASE_URL_POOLED = testUrl;
  delete process.env.DATABASE_URL;
}
