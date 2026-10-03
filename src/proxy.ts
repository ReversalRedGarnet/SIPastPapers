import { NextResponse, type NextRequest } from "next/server";
import { publicPagePaths } from "@/lib/db/public-paths";
import { isPrefetchRequest } from "@/lib/prefetch";

/**
 * Runs before Next.js renders (or looks up a stored copy of) any browse or
 * paper page. An address shaped like one of those pages that doesn't exist
 * gets the site's normal "not found" page with a real 404 status right
 * here -- so the page is never rendered, and no ISR copy of it is ever
 * stored. See src/lib/db/public-paths.ts for why that matters.
 *
 * If the list of real addresses can't be loaded, everything is let
 * through and the pages answer for themselves, as before.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // Prefetches are skipped by the matcher below; any that get here are
  // judged from the list already in memory, never by loading it.
  const verdict = isPrefetchRequest(request.headers)
    ? publicPagePaths.judgeFromMemory(pathname)
    : await publicPagePaths.judge(pathname);
  if (verdict === "missing") {
    // An address with no route behind it: Next.js answers it with the
    // (pre-built, static) not-found page and a 404 status.
    return NextResponse.rewrite(new URL("/_page-not-found", request.url), { status: 404 });
  }
  return NextResponse.next();
}

// Prefetches (see src/lib/prefetch.ts) don't run the proxy at all: a page
// links to up to ~24 others, each prefetched, which would otherwise be up
// to 25 proxy runs per page view instead of one. The matcher must be
// written out literally (Next.js reads it at build time), hence the
// repetition.
export const config = {
  matcher: [
    {
      source: "/browse/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose" },
      ],
    },
    {
      source: "/exams/:path*",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
        { type: "header", key: "sec-purpose" },
      ],
    },
  ],
};
