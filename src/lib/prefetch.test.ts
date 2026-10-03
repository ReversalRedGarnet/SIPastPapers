/** Which requests the proxy treats as prefetches. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrefetchRequest } from "./prefetch";

const PREFETCHES: Record<string, string>[] = [
  { "next-router-prefetch": "1", rsc: "1" },
  { purpose: "prefetch" },
  { Purpose: "Prefetch" },
  { "sec-purpose": "prefetch" },
  { "sec-purpose": "prefetch;prerender" },
  { "sec-purpose": "prefetch;anonymous-client-ip" },
];

const PAGE_VIEWS: Record<string, string>[] = [{}, { rsc: "1" }, { accept: "text/html" }, { purpose: "navigate" }];

test("Next.js link prefetches and browser prefetch/prerender requests are prefetches", () => {
  for (const headers of PREFETCHES) {
    assert.equal(isPrefetchRequest(new Headers(headers)), true, JSON.stringify(headers));
  }
});

test("page views, including client-side navigations, are not", () => {
  for (const headers of PAGE_VIEWS) {
    assert.equal(isPrefetchRequest(new Headers(headers)), false, JSON.stringify(headers));
  }
});
