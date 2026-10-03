import { NextResponse, type NextRequest } from "next/server";
import { getPublicPagePaths, judgePath } from "@/lib/db/public-paths";

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
  const paths = await getPublicPagePaths();
  if (paths && judgePath(paths, request.nextUrl.pathname) === "missing") {
    // An address with no route behind it: Next.js answers it with the
    // (pre-built, static) not-found page and a 404 status.
    return NextResponse.rewrite(new URL("/_page-not-found", request.url), { status: 404 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/browse/:path*", "/exams/:path*"],
};
