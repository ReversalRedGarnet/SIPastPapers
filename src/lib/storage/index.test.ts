/**
 * Covers getStorageProvider()'s backend switch (STORAGE_BACKEND=local|r2)
 * failing loudly on misconfiguration, rather than silently falling back
 * to local storage or a half-configured R2 client. Only the two
 * non-caching (throwing) paths are tested here: getStorageProvider()
 * caches its instance in a module-level singleton on the first
 * *successful* call, so — unlike R2Storage's own tests in r2.test.ts,
 * which construct instances directly — this file can't also assert
 * "defaults to local" and "builds an R2Storage" side by side in one
 * process without that first success locking in for every later call.
 * The default-to-local behavior is exercised implicitly by every test in
 * queries.test.ts and cli-lib.test.ts, which never set STORAGE_BACKEND.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("getStorageProvider throws a clear error when STORAGE_BACKEND=r2 but credentials are missing", async () => {
  process.env.STORAGE_BACKEND = "r2";
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;

  const { getStorageProvider } = await import("./index");
  assert.throws(() => getStorageProvider(), /R2_ACCOUNT_ID/);
});

test("getStorageProvider throws on an unrecognized STORAGE_BACKEND value", async () => {
  process.env.STORAGE_BACKEND = "s3-direct";

  const { getStorageProvider } = await import("./index");
  assert.throws(() => getStorageProvider(), /Unknown STORAGE_BACKEND/);
});
