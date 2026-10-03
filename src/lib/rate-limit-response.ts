import { NextResponse, type NextRequest } from "next/server";
import { VISITOR_COOKIE, VISITOR_COOKIE_OPTIONS, type RateLimitScope, type Visitor } from "@/lib/rate-limit";
import { noticePage, wantsHtml } from "@/lib/notice-page";

/**
 * The responses that go with src/lib/rate-limit.ts: the "please wait" page
 * a visitor sees when they hit a limit, and attaching the visitor cookie
 * to a response.
 */

/** Solomon Islands is a single time zone (UTC+11, no daylight saving). */
const SI_TIME_ZONE = "Pacific/Guadalcanal";

/** Sends the new visitor cookie with `response`, if this visitor needs one. */
export function withVisitorCookie<T extends NextResponse>(response: T, visitor: Visitor): T {
  if (visitor.newCookie) response.cookies.set(VISITOR_COOKIE, visitor.newCookie, VISITOR_COOKIE_OPTIONS);
  return response;
}

export function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatSolomonIslandsTime(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: SI_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function rateLimitedHtml(request: NextRequest, retryAfterSeconds: number, scope: RateLimitScope): string {
  const wait = formatWait(retryAfterSeconds);
  const until = formatSolomonIslandsTime(new Date(Date.now() + retryAfterSeconds * 1000));
  // When the limit that ran out is this browser's own, say so; when it's
  // the shared one for the whole internet address, explain that other
  // people's downloads count too.
  const what =
    scope === "visitor"
      ? "You&#39;ve opened or downloaded a lot of papers in the last few minutes."
      : "A lot of papers have been opened or downloaded from your internet connection in the last few minutes.";
  const shared =
    scope === "visitor"
      ? ""
      : "<p>If you&#39;re on a shared school, office or mobile connection, other people&#39;s downloads count towards the same limit.</p>";
  return noticePage(
    request,
    "Please wait a moment",
    "Please wait a moment before opening more papers",
    `<p>${what} To keep the archive free and working for everyone, there&#39;s a limit.</p>
  <p><strong>Please wait about ${wait} (until ${until} Solomon Islands time), then try again.</strong></p>
  ${shared}
  <p>Papers you&#39;ve already opened or downloaded are fine, and opening one of them again doesn&#39;t count.</p>`
  );
}

/**
 * The 429 "Too Many Requests" response: a readable page for browsers, JSON
 * for scripts, and a Retry-After header with the real wait in seconds
 * either way.
 */
export function rateLimitedResponse(
  request: NextRequest,
  limit: { retryAfterSeconds: number; scope: RateLimitScope }
): NextResponse {
  const headers = { "Retry-After": String(limit.retryAfterSeconds), "Cache-Control": "private, no-store" };
  if (wantsHtml(request)) {
    return new NextResponse(rateLimitedHtml(request, limit.retryAfterSeconds, limit.scope), {
      status: 429,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return NextResponse.json(
    {
      error: `Too many downloads. Please try again in about ${formatWait(limit.retryAfterSeconds)}.`,
      retryAfterSeconds: limit.retryAfterSeconds,
    },
    { status: 429, headers }
  );
}
