import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * This file is called `proxy.ts` rather than the older `middleware.ts` —
 * that's just what this newer version of Next.js calls the same feature
 * (it works exactly the same way). The `matcher` setting at the bottom of
 * this file limits it to just one specific web address.
 *
 * This limits how often any one visitor can request a "download whole
 * year as zip" file. That download isn't behind a login, and each request
 * does real work (compressing files, reading them from storage) across a
 * small, easy-to-guess set of possible web addresses (just a few exam
 * series × a fixed range of years). This only limits requests from one
 * source at a time — it isn't meant to, and can't, protect against a
 * large, distributed attack from many different sources at once. That
 * kind of protection would need to happen at the hosting/CDN level
 * instead.
 */

// The underscore in `60_000` is just a readability separator (like a comma
// in "60,000") -- JavaScript ignores it completely, so this is exactly the
// number 60000.
const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 5;

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

function isRateLimited(key: string): boolean {
  const now = Date.now();
  sweepExpired(now);

  const bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > MAX_REQUESTS_PER_WINDOW;
}

export function proxy(request: NextRequest) {
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many download requests. Please try again in a minute." },
      { status: 429, headers: { "Retry-After": String(WINDOW_MS / 1000) } }
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/download-year/:series/:year",
};
