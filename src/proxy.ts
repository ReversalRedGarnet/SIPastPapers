import type { NextRequest } from "next/server";
import { publicPagePaths } from "@/lib/db/public-paths";
import { guardPageRequest } from "@/lib/page-guard";

/**
 * Runs before Next.js renders (or looks up a stored copy of) any browse or
 * paper page. An address shaped like one of those pages that doesn't exist
 * gets the site's normal "not found" page with a real 404 status right
 * here -- so the page is never rendered, and no ISR copy of it is ever
 * stored. See src/lib/db/public-paths.ts for why that matters, and
 * src/lib/page-guard.ts for how prefetches are handled.
 *
 * If the list of real addresses can't be loaded, page views are let
 * through and the pages answer for themselves, as before.
 */
export function proxy(request: NextRequest) {
  return guardPageRequest(request, publicPagePaths);
}

// Every browse and paper request, prefetches included: a prefetch header
// mustn't be a way round the check. (Long lists of links don't prefetch --
// see prefetch={false} on them -- which keeps the number of runs down.)
export const config = {
  matcher: ["/browse/:path*", "/exams/:path*"],
};
