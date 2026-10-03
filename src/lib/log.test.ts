import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { anonymize, logEvent, userAgentClass, visitorLogFields } from "./log";

process.env.RATE_LIMIT_SECRET = "test-secret";

const IP = "203.0.113.42";

test("anonymize is stable within a day, changes the next day, and never contains the input", () => {
  const morning = new Date("2026-10-01T01:00:00Z");
  const evening = new Date("2026-10-01T22:00:00Z");
  const nextDay = new Date("2026-10-02T01:00:00Z");
  assert.equal(anonymize(IP, morning), anonymize(IP, evening));
  assert.notEqual(anonymize(IP, morning), anonymize(IP, nextDay));
  assert.notEqual(anonymize(IP, morning), anonymize("203.0.113.43", morning));
  assert.match(anonymize(IP, morning), /^[0-9a-f]{12}$/);
});

test("userAgentClass", () => {
  assert.equal(userAgentClass("Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36"), "mobile");
  assert.equal(userAgentClass("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120"), "desktop");
  assert.equal(userAgentClass("facebookexternalhit/1.1"), "bot");
  assert.equal(userAgentClass("Googlebot/2.1"), "bot");
  assert.equal(userAgentClass(null), "unknown");
});

test("logEvent writes one line of JSON, and visitor fields never include the raw address", () => {
  const log = mock.method(console, "log", () => {});
  try {
    logEvent("file", {
      outcome: "served",
      ...visitorLogFields({ ip: IP, visitorId: "visitor-1", newCookie: null }, "Googlebot/2.1"),
    });
    const line = log.mock.calls[0].arguments[0] as string;
    assert.ok(!line.includes("\n"));
    const parsed = JSON.parse(line);
    assert.equal(parsed.evt, "file");
    assert.equal(parsed.outcome, "served");
    assert.equal(parsed.ua, "bot");
    assert.equal(parsed.newVisitor, false);
    assert.ok(!line.includes(IP), "raw IP must never be logged");
    assert.ok(!line.includes("visitor-1"), "raw visitor id must never be logged");
  } finally {
    log.mock.restore();
  }
});
