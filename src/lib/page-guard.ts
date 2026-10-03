import { NextResponse, type NextRequest } from "next/server";
import type { PagePathsSnapshot } from "@/lib/db/public-paths";
import { isPrefetchRequest } from "@/lib/prefetch";

/**
 * What src/proxy.ts does with each browse or paper request, kept here so
 * tests can call it with their own list of addresses.
 *
 * A made-up address gets the site's "not found" page with a real 404
 * status, whatever headers the request carries -- so the page is never
 * rendered, and Next.js never stores an ISR copy of it.
 *
 * Browser prefetches (see src/lib/prefetch.ts) are only ever judged from
 * the list already in memory: they never load it, so they never cost a
 * database query. With no list in memory yet (a just-started copy of the
 * app), such a prefetch gets an empty, uncached 204 instead of being let
 * through -- otherwise a stream of requests that only ever claimed to be
 * prefetches would never load a list and never be checked. A real link
 * just isn't prefetched then; following it is a normal request.
 *
 * Next.js's own link prefetches reach the proxy looking like page views
 * (see src/lib/prefetch.ts), and are judged as such.
 *
 * A load of the list still under way when the answer is ready (the request
 * only waits so long for it) is handed to `waitUntil`, so it can finish
 * after the response has gone out.
 */
export async function guardPageRequest(
  request: NextRequest,
  paths: PagePathsSnapshot,
  waitUntil: (promise: Promise<unknown>) => void = () => {}
): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const verdict = isPrefetchRequest(request.headers) ? paths.judgeFromMemory(pathname) : await paths.judge(pathname);
  const pending = paths.pending();
  if (pending) waitUntil(pending);

  if (verdict === "missing") {
    // An address with no route behind it: Next.js answers it with the
    // (pre-built, static) not-found page and a 404 status.
    return NextResponse.rewrite(new URL("/_page-not-found", request.url), { status: 404 });
  }
  if (verdict === "no list") {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  }
  return NextResponse.next();
}
