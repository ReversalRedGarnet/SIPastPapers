import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * This file is called `proxy.ts` rather than the older `middleware.ts` —
 * that's just what this newer version of Next.js calls the same feature
 * (it works exactly the same way). The `matcher` setting at the bottom of
 * this file limits it to just one specific web address.
 *
 * This limits how often any one visitor can request a "download whole
 * year as zip" file, or a single paper's file directly. Neither download
 * is behind a login, and each request does real work (reading from
 * storage, and for the zip route, compressing too) — direct file
 * downloads also carry real storage egress cost as traffic grows. This
 * only limits requests from one source at a time — it isn't meant to, and
 * can't, protect against a large, distributed attack from many different
 * sources at once. That kind of protection would need to happen at the
 * hosting/CDN level instead.
 *
 * The limit is deliberately generous. Many visitors in Solomon Islands
 * share one public IP address (a mobile carrier's network, or a whole
 * school or office), so everyone behind that address shares this one
 * allowance. Opening a paper's page also counts once (its preview loads
 * the file), separately from pressing Download.
 */

// The underscore in `60_000` is just a readability separator (like a comma
// in "60,000") -- JavaScript ignores it completely, so this is exactly the
// number 60000.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 60;

/** Solomon Islands is a single time zone (UTC+11, no daylight saving). */
const SI_TIME_ZONE = "Pacific/Guadalcanal";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * This tracking is only kept in memory (not in a database), so it resets
 * whenever the app restarts or redeploys, and isn't shared between
 * different running copies of the app. In practice that means the limit
 * applies "per running copy of the app", not as one single hard global
 * limit. That's an acceptable trade-off for what we're actually trying to
 * prevent here (one source hammering this one endpoint), without needing
 * to add an external service (like Redis) that this small, low-traffic
 * site doesn't otherwise need.
 */
// A `Map` (unlike the plain lookup objects seen elsewhere, e.g.
// src/lib/format.ts's Record type) is a data structure specifically built
// for adding, reading, and removing key-value pairs *while the program is
// running* -- exactly what's needed here, since visitor IP addresses
// aren't known in advance.
const buckets = new Map<string, Bucket>();

/**
 * Prevents this tracking list from growing forever. Without this, a
 * visitor who shows up once and never comes back would leave a leftover
 * entry sitting in memory permanently. Instead, we clean out old entries
 * once the list gets large enough, rather than running a cleanup on a
 * timer (this file has no way to run a background task on a schedule).
 */
const SWEEP_THRESHOLD = 1000;

function sweepExpired(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  // Looping over a Map with `for...of` hands back each entry as a [key,
  // value] pair, which the `[key, bucket]` here immediately destructures
  // (see artifact-naming.ts) into two separate named variables.
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

function clientIp(request: NextRequest): string {
  // Our hosting platform (and most others) provides the visitor's address
  // in this header — there's no other reliable way to get it. If it's
  // missing (e.g. running locally), we fall back to treating every
  // visitor as one shared "unknown" visitor — the rate limit won't work
  // properly in that case, but at least it won't crash.
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded ? forwarded.split(",")[0].trim() : "unknown";
}

interface RateLimitResult {
  limited: boolean;
  /** Whole seconds until this visitor's current window ends (only meaningful when `limited` is true). */
  retryAfterSeconds: number;
}

function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  sweepExpired(now);

  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { limited: false, retryAfterSeconds: 0 };
  }
  bucket.count += 1;
  return {
    limited: bucket.count > MAX_REQUESTS_PER_WINDOW,
    // The window started at this visitor's first request, so the real wait
    // is whatever's left of it -- often much less than the full minute.
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/**
 * True when the request is a browser loading a page or the paper preview
 * frame (someone tapped a Download link, or the preview loaded), rather
 * than a script. Those visitors should see a readable page, not raw JSON.
 */
function wantsHtml(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === "document" || dest === "iframe") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

function formatWait(seconds: number): string {
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

function rateLimitedHtml(request: NextRequest, retryAfterSeconds: number): string {
  const wait = formatWait(retryAfterSeconds);
  const until = formatSolomonIslandsTime(new Date(Date.now() + retryAfterSeconds * 1000));
  const back = escapeHtml(backHref(request));
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
  <p>A lot of papers have been opened or downloaded from your internet connection in the last minute. To keep the archive free and working for everyone, there&#39;s a short limit.</p>
  <p><strong>Please wait about ${wait} (until ${until} Solomon Islands time), then try again.</strong></p>
  <p>If you&#39;re on a shared school, office or mobile connection, other people&#39;s downloads count towards the same limit. Papers you&#39;ve already downloaded are fine.</p>
  <p><a href="${back}" target="_top">Go back</a> · <a href="/" target="_top">Homepage</a></p>
</main>
</body>
</html>`;
}

export function proxy(request: NextRequest) {
  // A HEAD request only asks "what would this file's headers be?" (some
  // download managers and link-preview bots send one first) -- it isn't
  // a download, so it doesn't use up any of the visitor's allowance.
  if (request.method === "HEAD") return NextResponse.next();

  const { limited, retryAfterSeconds } = checkRateLimit(clientIp(request));
  if (!limited) return NextResponse.next();

  const headers = { "Retry-After": String(retryAfterSeconds), "Cache-Control": "no-store" };
  if (wantsHtml(request)) {
    return new NextResponse(rateLimitedHtml(request, retryAfterSeconds), {
      status: 429,
      headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
    });
  }
  return NextResponse.json(
    {
      error: `Too many downloads from this connection. Please try again in about ${formatWait(retryAfterSeconds)}.`,
      retryAfterSeconds,
    },
    { status: 429, headers }
  );
}

export const config = {
  matcher: ["/api/download-year/:series/:year", "/api/files/:fileId"],
};
