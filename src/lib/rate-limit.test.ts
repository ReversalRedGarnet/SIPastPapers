/**
 * Tests the rate limiter's counting rules directly -- pure in-memory
 * logic, no database or network. Each test starts from a clean slate, and
 * passes its own clock (`now`) so window timing is exact.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  identifyVisitor,
  mintVisitorCookie,
  rateLimit,
  rateLimitConfig,
  resetRateLimitsForTests,
  verifyVisitorCookie,
  type RateLimitResult,
} from "./rate-limit";

// 203.0.113.0/24 is reserved for documentation/examples (RFC 5737) —
// never a real visitor's address.
const SCHOOL_IP = "203.0.113.10";
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  resetRateLimitsForTests();
  savedEnv = { ...process.env };
  process.env.RATE_LIMIT_SECRET = "test-secret";
});

afterEach(() => {
  process.env = savedEnv;
});

/** A browser that already has a valid cookie, at `ip`. */
function returningVisitor(ip = SCHOOL_IP) {
  return identifyVisitor(mintVisitorCookie().value, ip);
}

function take(result: RateLimitResult): RateLimitResult {
  if (result.allowed) result.record();
  return result;
}

test("visitor cookies verify only if we signed them", () => {
  const { id, value } = mintVisitorCookie();
  assert.equal(verifyVisitorCookie(value), id);
  assert.equal(verifyVisitorCookie(`${id}.forged-signature`), null);
  assert.equal(verifyVisitorCookie(`made-up-id.${value.split(".")[1]}`), null);
  assert.equal(verifyVisitorCookie("no-dot-at-all"), null);
  assert.equal(verifyVisitorCookie(undefined), null);
});

test("a request without a valid cookie is issued a new one and counted as cookieless", () => {
  const fresh = identifyVisitor(undefined, `${SCHOOL_IP}, 10.0.0.1`);
  assert.equal(fresh.ip, SCHOOL_IP, "the first X-Forwarded-For entry is the visitor's address");
  assert.equal(fresh.visitorId, null);
  assert.ok(verifyVisitorCookie(fresh.newCookie!), "the issued cookie is valid next time");

  const forged = identifyVisitor("someone.else", SCHOOL_IP);
  assert.equal(forged.visitorId, null);

  const returning = returningVisitor();
  assert.ok(returning.visitorId);
  assert.equal(returning.newCookie, null);
});

test("the same file counts once, however many times it's requested", () => {
  const visitor = returningVisitor();
  const { perVisitor } = rateLimitConfig("open");
  for (let i = 0; i < perVisitor * 3; i++) {
    assert.equal(take(rateLimit("open", visitor, "file-1", T0 + i)).allowed, true);
  }
  // The visitor's whole allowance minus that one file is still free.
  for (let i = 2; i <= perVisitor; i++) {
    assert.equal(take(rateLimit("open", visitor, `file-${i}`, T0)).allowed, true);
  }
});

test("nothing counts until record() is called (a 404 or failure is free)", () => {
  const visitor = returningVisitor();
  const { perVisitor } = rateLimitConfig("open");
  for (let i = 0; i < perVisitor * 2; i++) {
    assert.equal(rateLimit("open", visitor, `missing-${i}`, T0).allowed, true); // never recorded
  }
  assert.equal(rateLimit("open", visitor, "real-file", T0).allowed, true);
});

test("a visitor is blocked after their allowance of distinct downloads, with the real wait", () => {
  const visitor = returningVisitor();
  const { perVisitor, windowMs } = rateLimitConfig("open");
  for (let i = 0; i < perVisitor; i++) take(rateLimit("open", visitor, `file-${i}`, T0 + i * 1000));

  const blocked = rateLimit("open", visitor, "one-more", T0 + 5 * MINUTE);
  assert.equal(blocked.allowed, false);
  if (blocked.allowed) return;
  assert.equal(blocked.scope, "visitor");
  // The first download (at T0) drops out of the 10-minute window at
  // T0 + 10 min, i.e. 5 minutes after this request.
  assert.equal(blocked.retryAfterSeconds, (windowMs - 5 * MINUTE) / 1000);

  // ...and a paper already downloaded can still be opened again.
  assert.equal(rateLimit("open", visitor, "file-0", T0 + 5 * MINUTE).allowed, true);
});

test("the window slides: once old downloads age out, new ones are allowed", () => {
  const visitor = returningVisitor();
  const { perVisitor, windowMs } = rateLimitConfig("open");
  for (let i = 0; i < perVisitor; i++) take(rateLimit("open", visitor, `file-${i}`, T0));
  assert.equal(rateLimit("open", visitor, "next", T0 + windowMs - 1).allowed, false);
  assert.equal(rateLimit("open", visitor, "next", T0 + windowMs).allowed, true);
});

test("students sharing one school/CGNAT address each get their own allowance", () => {
  const { perVisitor } = rateLimitConfig("open");
  for (let student = 0; student < 10; student++) {
    const visitor = returningVisitor(SCHOOL_IP);
    for (let i = 0; i < perVisitor; i++) {
      assert.equal(take(rateLimit("open", visitor, `s${student}-f${i}`, T0)).allowed, true);
    }
  }
});

test("the per-address backstop still applies across everyone at that address", () => {
  process.env.RATE_LIMIT_OPEN_PER_IP = "5";
  for (let i = 0; i < 5; i++) take(rateLimit("open", returningVisitor(), `f${i}`, T0));

  const blocked = rateLimit("open", returningVisitor(), "f5", T0);
  assert.equal(blocked.allowed, false);
  assert.equal(!blocked.allowed && blocked.scope, "ip");

  assert.equal(rateLimit("open", returningVisitor("203.0.113.99"), "f5", T0).allowed, true, "other addresses unaffected");
});

test("requests without a cookie share a smaller per-address allowance, so dropping cookies doesn't help", () => {
  const { perIpNoCookie } = rateLimitConfig("open");
  for (let i = 0; i < perIpNoCookie; i++) {
    assert.equal(take(rateLimit("open", identifyVisitor(undefined, SCHOOL_IP), `f${i}`, T0)).allowed, true);
  }
  const blocked = rateLimit("open", identifyVisitor(undefined, SCHOOL_IP), "one-more", T0);
  assert.equal(!blocked.allowed && blocked.scope, "no-cookie");

  // A browser that kept its cookie isn't affected.
  assert.equal(rateLimit("open", returningVisitor(), "one-more", T0).allowed, true);
});

test("buckets are separate: previews don't use up the allowance for opening papers", () => {
  const visitor = returningVisitor();
  const { perVisitor } = rateLimitConfig("open");
  for (let i = 0; i < perVisitor; i++) take(rateLimit("preview", visitor, `f${i}`, T0));
  assert.equal(rateLimit("open", visitor, "f0", T0).allowed, true);
});

test("limits come from environment variables, falling back to defaults when invalid", () => {
  process.env.RATE_LIMIT_ZIP_PER_VISITOR = "7";
  process.env.RATE_LIMIT_WINDOW_SECONDS = "60";
  process.env.RATE_LIMIT_ZIP_PER_IP = "lots";
  const config = rateLimitConfig("zip");
  assert.equal(config.perVisitor, 7);
  assert.equal(config.windowMs, 60_000);
  assert.equal(config.perIp, 20, "an invalid value falls back to the default");
});

test("default limits match the agreed starting values", () => {
  for (const name of Object.keys(process.env)) if (name.startsWith("RATE_LIMIT_") && name !== "RATE_LIMIT_SECRET") delete process.env[name];
  assert.deepEqual(rateLimitConfig("preview"), { windowMs: 600_000, perVisitor: 120, perIp: 1000, perIpNoCookie: 300 });
  assert.deepEqual(rateLimitConfig("open"), { windowMs: 600_000, perVisitor: 40, perIp: 600, perIpNoCookie: 60 });
  assert.deepEqual(rateLimitConfig("zip"), { windowMs: 600_000, perVisitor: 3, perIp: 20, perIpNoCookie: 10 });
});
