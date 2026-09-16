import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Named `proxy.ts`, not `middleware.ts` -- Next.js 16 renamed the
 * middleware file convention to Proxy (functionality is identical, see
 * node_modules/next/dist/docs/.../file-conventions/proxy.md). This file is
 * scoped by `matcher` below to exactly one route.
 *
 * IP-based rate limit for /api/download-year/[series]/[year]: no auth, and
 * each request drives real zlib compression plus a storage read per file in
 * that year, over a small, fully enumerable URL space (3 series x a fixed
 * year range -- see src/lib/browse-years.ts). This bounds request volume
 * from one source; it does not replace CDN/host-level protection against a
 * distributed attack, and deliberately doesn't try to be one -- see the
 * in-memory tradeoffs below.
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 5;

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory only: resets on cold start/redeploy and isn't shared across
 * serverless instances or regions, so the real-world limit is "per warm
 * instance" rather than a hard global cap. That's an appropriate match for
 * this route's actual threat model (a script hammering the endpoint from
 * one place) without pulling in an external store (Redis/Upstash) that
 * this low-traffic site doesn't otherwise need.
 */
const buckets = new Map<string, Bucket>();

/**
 * Unbounded map growth guard: a distinct IP that hits once and never
 * returns would otherwise leave a stale entry forever. Sweep opportunistically
 * once the map gets large, rather than on a timer (proxy has no persistent
 * background scheduler to hang one off).
 */
const SWEEP_THRESHOLD = 1000;

function sweepExpired(now: number): void {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
}

function clientIp(request: NextRequest): string {
  // Vercel (and most proxies) set this; there's no other reliable way to
  // get the caller's address from a NextRequest. Falls back to a single
  // shared bucket for local/self-hosted setups that don't set it -- not a
  // real limit in that case, but not a crash either.
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
