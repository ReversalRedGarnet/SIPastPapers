/**
 * Tests the retry logic in withRetry/isTransientConnectionError directly,
 * using a hand-crafted function instead of a real database connection --
 * this is pure control-flow logic (how many times to retry, and for which
 * kinds of errors), so it doesn't need a real Postgres connection to test.
 * This file clears DB_POOL_PROFILE (in case the shell set it), so
 * getRetryBudget() resolves to the "web" profile throughout, same as a real
 * page load.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { withOwnConnection, withRetry } from "./client";
import { isTransientConnectionError } from "./transient-error";

delete process.env.DB_POOL_PROFILE;

function transientError(code: string): NodeJS.ErrnoException {
  const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("isTransientConnectionError recognizes known transient codes and messages, but not a real error", () => {
  assert.ok(isTransientConnectionError(transientError("ECONNRESET")));
  assert.ok(isTransientConnectionError(transientError("ETIMEDOUT")));
  assert.ok(isTransientConnectionError(new Error("Connection terminated unexpectedly")));
  assert.ok(!isTransientConnectionError(new Error('syntax error at or near "selct"')));
  assert.ok(!isTransientConnectionError("not even an Error"));
});

test("withRetry retries a transient connection error once, then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls === 1) throw transientError("ECONNRESET");
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2, "should have failed once, then succeeded on the retry");
});

test("withRetry does not retry a non-transient (real SQL) error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw new Error('syntax error at or near "selct"');
    }),
    /syntax error/
  );
  assert.equal(calls, 1, "a non-transient error should fail immediately, with no retry");
});

test("the web profile stops after 2 total attempts even if the error keeps recurring", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw transientError("ECONNRESET");
    })
  );
  assert.equal(calls, 2, "web profile allows only 2 total attempts (the original try plus 1 retry)");
});

test("withOwnConnection gives up after its own connect timeout, with a single attempt and no retry", async () => {
  // A server that accepts connections but never answers: the connect
  // timeout has to fire.
  let connections = 0;
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    connections++;
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  const saved = process.env.DATABASE_URL_POOLED;
  process.env.DATABASE_URL_POOLED = `postgresql://user:pass@127.0.0.1:${port}/db`;
  try {
    const startedAt = Date.now();
    let ran = false;
    await assert.rejects(
      withOwnConnection(300, async () => {
        ran = true;
      })
    );
    const elapsed = Date.now() - startedAt;
    assert.equal(ran, false);
    assert.equal(connections, 1, "one attempt, no retry");
    assert.ok(elapsed >= 250 && elapsed < 2_000, `gave up after ${elapsed} ms`);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL_POOLED;
    else process.env.DATABASE_URL_POOLED = saved;
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
  }
});
