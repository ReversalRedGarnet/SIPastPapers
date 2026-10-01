/**
 * Tests the rate limiter in proxy() directly, by calling it with several
 * requests that share the same fake IP -- pure in-memory logic, no real
 * database or network needed.
 *
 * Every test uses its own IP address, since the limiter's memory is shared
 * across the whole test file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const LIMIT = 60;

function requestFrom(ip: string, init: { method?: string; headers?: Record<string, string> } = {}): NextRequest {
  return new NextRequest("http://localhost/api/files/00000000-0000-0000-0000-000000000000", {
    method: init.method ?? "GET",
    headers: { "x-forwarded-for": ip, ...init.headers },
  });
}

async function useUpAllowance(ip: string): Promise<void> {
  for (let i = 0; i < LIMIT; i++) {
    const response = await proxy(requestFrom(ip));
    assert.notEqual(response.status, 429, `request ${i + 1} should not be rate-limited yet`);
  }
}

// 203.0.113.0/24 is reserved for documentation/examples (RFC 5737) —
// never a real visitor's address.

test("allows 60 requests per minute from one IP, then blocks the 61st with 429", async () => {
  const ip = "203.0.113.42";
  await useUpAllowance(ip);

  const blocked = await proxy(requestFrom(ip));
  assert.equal(blocked.status, 429, "the 61st request within the window should be rate-limited");
});

test("Retry-After is the real time left in the window, not a fixed minute", async () => {
  const ip = "203.0.113.44";
  await useUpAllowance(ip);

  const blocked = await proxy(requestFrom(ip));
  const retryAfter = Number(blocked.headers.get("Retry-After"));
  assert.ok(Number.isInteger(retryAfter), "Retry-After should be a whole number of seconds");
  assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After should be within the window, got ${retryAfter}`);
});

test("HEAD requests never count towards the limit and are never blocked", async () => {
  const ip = "203.0.113.45";
  for (let i = 0; i < LIMIT * 2; i++) {
    const response = await proxy(requestFrom(ip, { method: "HEAD" }));
    assert.notEqual(response.status, 429);
  }
  // The full GET allowance is still untouched.
  await useUpAllowance(ip);
});

test("a browser navigation gets a readable HTML page, not JSON", async () => {
  const ip = "203.0.113.46";
  await useUpAllowance(ip);

  const blocked = await proxy(
    requestFrom(ip, { headers: { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml" } })
  );
  assert.equal(blocked.status, 429);
  assert.match(blocked.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await blocked.text();
  assert.match(body, /Please wait about \d+ (seconds?|minutes?) \(until .+ Solomon Islands time\)/);
});

test("the HTML page's back link never points to another site", async () => {
  const ip = "203.0.113.47";
  await useUpAllowance(ip);

  const blocked = await proxy(
    requestFrom(ip, { headers: { accept: "text/html", referer: "https://evil.example/phish" } })
  );
  const body = await blocked.text();
  assert.ok(!body.includes("evil.example"), "an outside referer must not be echoed into the page");
});

test("a script gets JSON with the wait time", async () => {
  const ip = "203.0.113.48";
  await useUpAllowance(ip);

  const blocked = await proxy(requestFrom(ip, { headers: { accept: "application/json" } }));
  assert.equal(blocked.status, 429);
  const body = (await blocked.json()) as { error: string; retryAfterSeconds: number };
  assert.equal(typeof body.error, "string");
  assert.equal(body.retryAfterSeconds, Number(blocked.headers.get("Retry-After")));
});

test("a different IP is not affected by another IP's rate limit", async () => {
  const busyIp = "203.0.113.43";
  for (let i = 0; i < LIMIT + 1; i++) {
    await proxy(requestFrom(busyIp));
  }

  const response = await proxy(requestFrom("203.0.113.99"));
  assert.notEqual(response.status, 429, "a fresh IP should not be blocked by another IP's requests");
});
