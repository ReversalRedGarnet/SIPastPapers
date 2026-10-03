/**
 * What the proxy does with browse and paper requests (src/lib/page-guard.ts),
 * with an in-memory list of addresses -- no database.
 *
 * Next.js only ever stores an ISR copy of a page it renders. A request the
 * guard answers itself (the 404 rewrite to the static not-found page, or the
 * empty 204) never reaches the page, so nothing can be stored for it; only
 * NextResponse.next() lets a request through to be rendered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, type NextResponse } from "next/server";
import { createPagePathsSnapshot, type PublicPagePaths } from "@/lib/db/public-paths";
import { guardPageRequest } from "./page-guard";
import { config } from "@/proxy";

const PATHS: PublicPagePaths = {
  seriesCodes: new Set(["sisc-l1"]),
  years: new Set([2016]),
  subjectSlugs: new Set(["mathematics"]),
  paperPaths: new Set(["sisc-l1/2016/mathematics/paper-1"]),
};
const REAL_PAPER = "/exams/sisc-l1/2016/mathematics/paper-1";
const MADE_UP = ["/exams/sisc-l1/2016/mathematics/made-up", "/browse/sisc-l1/2016/made-up", "/browse/nope"];

const HEADER_SETS: Record<string, string>[] = [
  {},
  { rsc: "1" },
  { "next-router-prefetch": "1", rsc: "1" },
  { "next-router-prefetch": "1", "next-router-segment-prefetch": "/_tree", rsc: "1" },
  { purpose: "prefetch" },
  { "sec-purpose": "prefetch;prerender" },
];

function snapshotWithList() {
  const counter = { loads: 0 };
  const snapshot = createPagePathsSnapshot(async () => {
    counter.loads++;
    return PATHS;
  });
  return { snapshot, counter };
}

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(path, "https://www.sipastexams.com"), { headers });
}

function rendersPage(response: NextResponse) {
  return response.headers.get("x-middleware-next") === "1";
}

test("a made-up address gets the proxy's own 404, whatever headers it sends -- it's never rendered, so never stored", async () => {
  const { snapshot, counter } = snapshotWithList();
  await snapshot.judge("/browse", Date.now()); // list loaded, as after the first page view

  for (const path of MADE_UP) {
    for (const headers of HEADER_SETS) {
      const response = await guardPageRequest(request(path, headers), snapshot);
      const label = `${path} ${JSON.stringify(headers)}`;
      assert.equal(response.status, 404, label);
      assert.match(response.headers.get("x-middleware-rewrite") ?? "", /\/_page-not-found$/, label);
      assert.equal(rendersPage(response), false, label);
    }
  }
  assert.equal(counter.loads, 1, "no reloads: page views were inside the 30 s gap, prefetches never reload");
});

test("with no list in memory, a browser prefetch is answered with an empty uncached 204 and never loads the list", async () => {
  const { snapshot, counter } = snapshotWithList();
  for (const headers of HEADER_SETS.filter((h) => h.purpose || h["sec-purpose"])) {
    for (const path of [REAL_PAPER, ...MADE_UP]) {
      const response = await guardPageRequest(request(path, headers), snapshot);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.equal(rendersPage(response), false);
    }
  }
  assert.equal(counter.loads, 0);
});

test("a real address is let through to the page, prefetch or not", async () => {
  const { snapshot } = snapshotWithList();
  await snapshot.judge("/browse", Date.now());
  for (const headers of HEADER_SETS) {
    assert.equal(rendersPage(await guardPageRequest(request(REAL_PAPER, headers), snapshot)), true, JSON.stringify(headers));
  }
});

test("the proxy runs on every browse and paper request: no header lets a request skip it", () => {
  assert.deepEqual(config.matcher, ["/browse/:path*", "/exams/:path*"]);
});
