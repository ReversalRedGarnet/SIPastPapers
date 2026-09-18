/**
 * Tests the rate limiter in proxy() directly, by calling it with several
 * requests that share the same fake IP -- pure in-memory logic, no real
 * database or network needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

function requestFrom(ip: string): NextRequest {
  return new NextRequest("http://localhost/api/download-year/sisc-l1/2020", {
    headers: { "x-forwarded-for": ip },
  });
}

test("allows 5 requests per minute from one IP, then blocks the 6th with 429", async () => {
  // 203.0.113.0/24 is reserved for documentation/examples (RFC 5737) —
  // never a real visitor's address.
  const ip = "203.0.113.42";
  const responses = [];
  for (let i = 0; i < 6; i++) {
    responses.push(await proxy(requestFrom(ip)));
  }

  for (let i = 0; i < 5; i++) {
    assert.notEqual(responses[i].status, 429, `request ${i + 1} should not be rate-limited yet`);
  }

  assert.equal(responses[5].status, 429, "the 6th request within the window should be rate-limited");
  assert.ok(responses[5].headers.get("Retry-After"), "a 429 response should include a Retry-After header");
});

test("a different IP is not affected by another IP's rate limit", async () => {
  const busyIp = "203.0.113.43";
  for (let i = 0; i < 6; i++) {
    await proxy(requestFrom(busyIp));
  }

  const response = await proxy(requestFrom("203.0.113.99"));
  assert.notEqual(response.status, 429, "a fresh IP should not be blocked by another IP's requests");
});
