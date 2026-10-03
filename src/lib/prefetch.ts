/**
 * True for a request the browser or Next.js sends ahead of time, in case the
 * visitor follows a link -- not a page someone has actually asked for:
 *
 * - `Next-Router-Prefetch`: Next.js's <Link> prefetching a page;
 * - `Purpose: prefetch`: older browsers' link prefetching;
 * - `Sec-Purpose: prefetch...`: current browsers' prefetch and prerender
 *   (every value it can take starts with "prefetch").
 *
 * src/proxy.ts's matcher skips these same three headers, so the proxy
 * doesn't run for them at all; this is for the proxy's own check.
 */
export function isPrefetchRequest(headers: Headers): boolean {
  return (
    headers.has("next-router-prefetch") ||
    headers.get("purpose")?.toLowerCase() === "prefetch" ||
    (headers.get("sec-purpose")?.toLowerCase().includes("prefetch") ?? false)
  );
}
