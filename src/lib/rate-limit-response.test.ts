/**
 * Tests the "please wait" response a visitor gets when they hit a rate
 * limit, and the visitor cookie being attached to responses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";
import { rateLimitedResponse, withVisitorCookie } from "./rate-limit-response";
import { VISITOR_COOKIE } from "./rate-limit";

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/files/00000000-0000-0000-0000-000000000000", { headers });
}

test("a browser navigation gets a readable HTML page with the wait in Solomon Islands time", async () => {
  const response = rateLimitedResponse(
    request({ "sec-fetch-dest": "document", accept: "text/html" }),
    { retryAfterSeconds: 240, scope: "visitor" }
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "240");
  assert.match(response.headers.get("Content-Type") ?? "", /^text\/html/);
  const body = await response.text();
  assert.match(body, /Please wait about 4 minutes \(until .+ Solomon Islands time\)/);
  assert.match(body, /You&#39;ve opened or downloaded a lot of papers/);
  assert.ok(!body.includes("shared school"), "a per-visitor limit doesn't blame the shared connection");
});

test("the preview frame also gets HTML, and a shared-address limit explains other people count too", async () => {
  const response = rateLimitedResponse(request({ "sec-fetch-dest": "iframe" }), { retryAfterSeconds: 30, scope: "ip" });
  const body = await response.text();
  assert.match(body, /about 30 seconds/);
  assert.match(body, /shared school, office or mobile connection/);
});

test("the page's back link never points to another site", async () => {
  const response = rateLimitedResponse(
    request({ accept: "text/html", referer: "https://evil.example/phish" }),
    { retryAfterSeconds: 60, scope: "visitor" }
  );
  assert.ok(!(await response.text()).includes("evil.example"));
});

test("a script gets JSON with the wait", async () => {
  const response = rateLimitedResponse(request({ accept: "application/json" }), { retryAfterSeconds: 90, scope: "visitor" });
  assert.equal(response.status, 429);
  const body = (await response.json()) as { error: string; retryAfterSeconds: number };
  assert.equal(body.retryAfterSeconds, 90);
  assert.match(body.error, /about 2 minutes/);
});

test("withVisitorCookie sets the cookie only for a visitor who needs one", () => {
  const withNew = withVisitorCookie(new NextResponse("ok"), { ip: "x", visitorId: null, newCookie: "abc.def" });
  const setCookie = withNew.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`^${VISITOR_COOKIE.replace("-", "\\-")}=abc\\.def`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /Secure/i);
  assert.match(setCookie, /SameSite=lax/i);
  assert.match(setCookie, /Path=\//);

  const returning = withVisitorCookie(new NextResponse("ok"), { ip: "x", visitorId: "id", newCookie: null });
  assert.equal(returning.headers.get("set-cookie"), null);
});
