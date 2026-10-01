import { NextResponse, type NextRequest } from "next/server";
import { getFileForDownload } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { contentDispositionHeader } from "@/lib/artifact-naming";
import { identifyVisitor, rateLimit, VISITOR_COOKIE } from "@/lib/rate-limit";
import { rateLimitedResponse, withVisitorCookie } from "@/lib/rate-limit-response";
import { logEvent, visitorLogFields } from "@/lib/log";

/**
 * Serves the original PDF for a published exam paper. Direct PDF download
 * must always work here, with no JavaScript-dependent viewer required.
 * getFileForDownload checks the paper's CURRENT status on every single
 * request, so a file stops being served the moment its paper is no longer
 * "published" (for example, if it's put on a rights hold or withdrawn) —
 * even if the actual file is still sitting there in storage.
 *
 * Adding `?dl=1` to the address forces a download; without it, the
 * browser is free to just display the PDF directly (the normal, default
 * PDF viewing behavior). The two are limited separately (see
 * src/lib/rate-limit.ts): viewing has the larger allowance.
 */

type RouteContext = { params: Promise<{ fileId: string }> };

function fileHeaders(file: { mime: string; title: string; bytes: number }, download: boolean): Record<string, string> {
  return {
    "Content-Type": file.mime,
    "Content-Disposition": contentDispositionHeader(download ? "attachment" : "inline", file.title),
    "Content-Length": String(file.bytes),
    "X-Content-Type-Options": "nosniff",
    // A paper's rights/publication status can change at any moment, so
    // we tell browsers and any in-between servers never to cache this
    // file — they must always check back with us fresh, rather than
    // serving an old, possibly-no-longer-allowed copy.
    "Cache-Control": "no-store",
  };
}

// This is what the glossary calls an "API route": unlike a page.tsx file
// (which returns JSX describing something to look at), a route.ts file
// returns raw data or, as here, a file's actual bytes. Exporting a
// function specifically named `GET` is a Next.js convention that makes it
// handle GET requests -- the kind of request a browser sends when simply
// visiting a link or an <img>/<a> tag points here; other names (`POST`,
// `DELETE`, ...) would handle those other kinds of requests instead.
export async function GET(request: NextRequest, { params }: RouteContext) {
  const startedAt = Date.now();
  const { fileId } = await params;
  const download = request.nextUrl.searchParams.get("dl") === "1";
  const bucket = download ? "download" : "view";
  const visitor = identifyVisitor(request.cookies.get(VISITOR_COOKIE)?.value, request.headers.get("x-forwarded-for"));
  const logFields = { fileId, kind: bucket, ...visitorLogFields(visitor, request.headers.get("user-agent")) };

  // Checked before doing any work, so a visitor over their limit costs
  // nothing more than this.
  const limit = rateLimit(bucket, visitor, fileId);
  if (!limit.allowed) {
    logEvent("rate_limited", { bucket, scope: limit.scope, retryAfterSeconds: limit.retryAfterSeconds, ...logFields });
    return withVisitorCookie(rateLimitedResponse(request, limit), visitor);
  }

  const file = await getFileForDownload(fileId);
  // `new NextResponse(...)` builds an HTTP response by hand -- a status
  // code (404 here means "not found") and a body -- which is what actually
  // gets sent back over the network to whatever asked for this address.
  if (!file) {
    logEvent("file", { outcome: "not_found", ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(new NextResponse("Not found", { status: 404 }), visitor);
  }

  const bytes = await getStorageProvider().get(file.storageKey);
  if (!bytes) {
    logEvent("file", { outcome: "missing_in_storage", ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(new NextResponse("File is missing from storage", { status: 404 }), visitor);
  }

  // Only now that the file is actually being sent does it count towards
  // the visitor's allowance.
  limit.record();
  logEvent("file", { outcome: "served", bytes: bytes.byteLength, ms: Date.now() - startedAt, ...logFields });
  return withVisitorCookie(
    new NextResponse(new Uint8Array(bytes), { status: 200, headers: fileHeaders(file, download) }),
    visitor
  );
}

/**
 * A HEAD request asks only for a file's headers (some download managers
 * and link-preview bots send one first). It's answered from the database
 * alone -- no storage read -- and never counts towards any limit.
 */
export async function HEAD(request: NextRequest, { params }: RouteContext) {
  const { fileId } = await params;
  const file = await getFileForDownload(fileId);
  if (!file) return new NextResponse(null, { status: 404 });
  const download = request.nextUrl.searchParams.get("dl") === "1";
  return new NextResponse(null, { status: 200, headers: fileHeaders(file, download) });
}
