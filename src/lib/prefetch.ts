/**
 * True for a request the browser sends ahead of time, in case the visitor
 * follows a link -- not a page someone has actually asked for:
 *
 * - `Purpose: prefetch`: older browsers' link prefetching;
 * - `Sec-Purpose: prefetch...`: current browsers' prefetch and prerender
 *   (every value it can take starts with "prefetch").
 *
 * The proxy judges these from the list of addresses already in memory,
 * never loading it (src/lib/page-guard.ts).
 *
 * Next.js's own <Link> prefetches can't be told apart here: Next.js removes
 * its router headers (RSC, Next-Router-Prefetch, ...) from the request
 * before the proxy sees it (next/dist/server/web/adapter.js), so to the
 * proxy they look like page views. That costs no database work for a real
 * link once the list is in memory -- and the long lists of links on the
 * site don't prefetch at all (prefetch={false}).
 */
export function isPrefetchRequest(headers: Headers): boolean {
  return (
    headers.get("purpose")?.toLowerCase() === "prefetch" ||
    (headers.get("sec-purpose")?.toLowerCase().includes("prefetch") ?? false)
  );
}
