/**
 * Tests that getStorageProvider() (which picks which storage system to
 * use) fails clearly and loudly when misconfigured, instead of silently
 * falling back to local storage or building a broken cloud-storage
 * connection.
 *
 * It tests the two failure cases, then -- last, because getStorageProvider()
 * remembers the storage system it picked after the first successful call
 * and that would lock in for every test after it -- what the one-time
 * "[storage]" log line reveals about the R2 settings. Unlike r2.test.ts
 * (which builds R2Storage instances directly), this file can't also test
 * "defaults to local storage" in the same run. That behavior is already
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

// Must stay the last test in this file (see the top of the file).
test("the [storage] log line names the bucket and the key ID's last 4 characters, and nothing else from the R2 settings", async () => {
  const accountId = "0123456789abcdef0123456789abcdef";
  const accessKeyId = "AKEYIDFORTESTS0000000000WXYZ";
  const secretAccessKey = "s3cr3t-value-that-must-never-be-logged";
  process.env.STORAGE_BACKEND = "r2";
  process.env.R2_ACCOUNT_ID = accountId;
  process.env.R2_ACCESS_KEY_ID = accessKeyId;
  process.env.R2_SECRET_ACCESS_KEY = secretAccessKey;
  process.env.R2_BUCKET_NAME = "test-bucket";

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    const { getStorageProvider } = await import("./index");
    getStorageProvider();
  } finally {
    console.log = originalLog;
  }

  const output = lines.join("\n");
  assert.match(output, /\[storage\] STORAGE_BACKEND=r2 -> R2Storage \(bucket="test-bucket", accessKeyId="\.\.\.WXYZ"\)/);
  assert.ok(!output.includes(accountId), "no account ID");
  assert.ok(!/cloudflarestorage|endpoint/i.test(output), "no endpoint");
  assert.ok(!output.includes(secretAccessKey), "no secret key");
  assert.ok(!output.includes(accessKeyId.slice(-5)), "no more than the key ID's last 4 characters");
});
