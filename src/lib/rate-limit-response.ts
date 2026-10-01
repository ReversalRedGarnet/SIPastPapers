import { NextResponse, type NextRequest } from "next/server";
import { VISITOR_COOKIE, VISITOR_COOKIE_OPTIONS, type RateLimitScope, type Visitor } from "@/lib/rate-limit";

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

/**
 * True when the request is a browser loading a page or the paper preview
 * frame (someone tapped a link, or the preview loaded), rather than a
 * script. Those visitors should see a readable page, not raw JSON.
 */
function wantsHtml(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === "document" || dest === "iframe") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Where the "go back" link on the limit page should point: the page the
 * visitor came from, but only if it's on this same site (never an outside
 * address), otherwise the homepage.
 */
function backHref(request: NextRequest): string {
  const referer = request.headers.get("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    return url.origin === request.nextUrl.origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}

function rateLimitedHtml(request: NextRequest, retryAfterSeconds: number, scope: RateLimitScope): string {
  const wait = formatWait(retryAfterSeconds);
  const until = formatSolomonIslandsTime(new Date(Date.now() + retryAfterSeconds * 1000));
  const back = escapeHtml(backHref(request));
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
  // `target="_top"` matters when this page shows up inside the paper's
  // preview frame: it makes the link replace the whole page rather than
  // just the little preview box.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Please wait a moment — SI National Exam Archive</title>
<style>
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0; padding: 1.5rem 1rem; color: #201f1e; background: #fff; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  a { color: #1e3a5f; }
  @media (prefers-color-scheme: dark) { body { color: #f3f2f1; background: #1f1f1f; } a { color: #5b8def; } }
</style>
</head>
<body>
<main>
  <h1>Please wait a moment before opening more papers</h1>
  <p>${what} To keep the archive free and working for everyone, there&#39;s a limit.</p>
  <p><strong>Please wait about ${wait} (until ${until} Solomon Islands time), then try again.</strong></p>
  ${shared}
  <p>Papers you&#39;ve already opened or downloaded are fine, and opening one of them again doesn&#39;t count.</p>
  <p><a href="${back}" target="_top">Go back</a> · <a href="/" target="_top">Homepage</a></p>
</main>
</body>
</html>`;
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
