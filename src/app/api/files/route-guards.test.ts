/**
 * Tests the /api/files route's early checks -- the ones that must answer
 * before the database is ever asked. No database is configured here at
 * all (DATABASE_URL_POOLED is unset), so if any of these requests reached
 * the database the connection attempt would throw and the test would fail.
 *
 * Lives one level up, outside the [fileId] folder, for the same reason as
 * route.test.ts: "[fileId]" in a path given to the test runner is glob
 * syntax.
 */
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { mintVisitorCookie, rateLimit, resetRateLimitsForTests, identifyVisitor, VISITOR_COOKIE } from "@/lib/rate-limit";

let GET: typeof import("./[fileId]/route").GET;
let HEAD: typeof import("./[fileId]/route").HEAD;

const FILE_A = "11111111-1111-4111-8111-111111111111";
const FILE_B = "22222222-2222-4222-8222-222222222222";

before(async () => {
  delete process.env.DATABASE_URL_POOLED;
  delete process.env.DATABASE_URL;
  process.env.STORAGE_BACKEND = "local";
  process.env.RATE_LIMIT_SECRET = "test-secret";
  ({ GET, HEAD } = await import("./[fileId]/route"));
});

beforeEach(() => {
  resetRateLimitsForTests();
  delete process.env.RATE_LIMIT_VIEW_PER_VISITOR;
});

function call(handler: typeof GET, fileId: string, headers: Record<string, string> = {}) {
  const request = new NextRequest(`http://localhost/api/files/${fileId}`, {
    method: handler === HEAD ? "HEAD" : "GET",
    headers: { "x-forwarded-for": "203.0.113.7", ...headers },
  });
  return handler(request, { params: Promise.resolve({ fileId }) });
}

test("an id that isn't a UUID is a 404 without asking the database (GET and HEAD)", async () => {
  const response = await call(GET, "not-a-uuid");
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await call(HEAD, "1 or 1=1")).status, 404);
});

test("a first-time visitor is given the visitor cookie, even on a 404", async () => {
  const response = await call(GET, "not-a-uuid");
  assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${VISITOR_COOKIE}=`));
});

test("a visitor over their allowance gets a 429 before the database is asked", async () => {
  process.env.RATE_LIMIT_VIEW_PER_VISITOR = "1";
  const cookie = mintVisitorCookie().value;
  // This visitor has already been served one (different) file.
  const used = rateLimit("view", identifyVisitor(cookie, "203.0.113.7"), FILE_A);
  assert.ok(used.allowed);
  used.record();

  const response = await call(GET, FILE_B, { cookie: `${VISITOR_COOKIE}=${cookie}`, accept: "text/html" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.match(await response.text(), /Please wait about/);
});
