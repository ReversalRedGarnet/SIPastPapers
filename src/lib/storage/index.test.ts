/**
 * Tests that getStorageProvider() (which picks which storage system to
 * use) fails clearly and loudly when misconfigured, instead of silently
 * falling back to local storage or building a broken cloud-storage
 * connection.
 *
 * This only tests the two failure cases. getStorageProvider() remembers
 * the storage system it picked after the first successful call, so unlike
 * r2.test.ts (which builds R2Storage instances directly), this file can't
 * test "defaults to local storage" and "builds a working cloud connection"
 * side by side in the same run — the first success would lock in for
 * every test after it. The "defaults to local storage" behavior is already
 * indirectly tested by every test in queries.test.ts and cli-lib.test.ts,
 * none of which set STORAGE_BACKEND themselves.
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
