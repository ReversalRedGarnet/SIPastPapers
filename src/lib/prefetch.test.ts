/** Which requests the proxy treats as prefetches. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrefetchRequest } from "./prefetch";

const PREFETCHES: Record<string, string>[] = [
  { purpose: "prefetch" },
  { Purpose: "Prefetch" },
  { "sec-purpose": "prefetch" },
  { "sec-purpose": "prefetch;prerender" },
  { "sec-purpose": "prefetch;anonymous-client-ip" },
];

// Next-Router-Prefetch is listed for the record: Next.js strips it before
// the proxy runs, so the proxy never sees it and treats such a request as
// a page view.
const PAGE_VIEWS: Record<string, string>[] = [
  {},
  { rsc: "1" },
  { accept: "text/html" },
  { purpose: "navigate" },
  { "next-router-prefetch": "1" },
];

test("browser prefetch and prerender requests are prefetches", () => {
  for (const headers of PREFETCHES) {
    assert.equal(isPrefetchRequest(new Headers(headers)), true, JSON.stringify(headers));
  }
});

test("page views, client-side navigations and Next.js's own prefetch header are not", () => {
  for (const headers of PAGE_VIEWS) {
    assert.equal(isPrefetchRequest(new Headers(headers)), false, JSON.stringify(headers));
  }
});
