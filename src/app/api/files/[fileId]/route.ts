import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { getFileForDownload } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { PRESIGNED_LINK_SECONDS } from "@/lib/storage/serving-headers";
import { contentDispositionHeader } from "@/lib/artifact-naming";
import { identifyVisitor, rateLimit, VISITOR_COOKIE } from "@/lib/rate-limit";
import { rateLimitedResponse, withVisitorCookie } from "@/lib/rate-limit-response";
import { logEvent, visitorLogFields } from "@/lib/log";
import { isUuid } from "@/lib/uuid";

/**
 * The address every "View" and "Download" link on the site points to
 * (/api/files/<file id>). It never sends the PDF itself in production.
 * Instead, on every request it:
 *
 *   1. checks the visitor's allowance (src/lib/rate-limit.ts),
 *   2. checks, fresh from the database, that the paper is published, its
 *      rights are currently approved, and this is its current file
 *      (getFileForDownload) -- so a withdrawn paper stops being handed out
 *      at once,
 *   3. sends the browser on to a temporary "presigned" link that
 *      downloads the file straight from R2, valid for 10 minutes.
 *
 * R2 then does the heavy lifting -- including letting an interrupted
 * download resume part-way (Range requests) -- with the file's stored
 * name and headers (see src/lib/storage/serving-headers.ts), without the
 * bytes ever passing through this app.
 *
 * With local storage (development), which can't make presigned links,
 * the file is streamed through this route instead.
 *
 * `?dl=1` marks a Download (vs. View) click. Both are limited separately
 * (viewing has the larger allowance); the file opens the same way either
 * way, since its stored headers say "inline".
 */

type RouteContext = { params: Promise<{ fileId: string }> };

// Neither the redirect (it carries a link that expires) nor the file
// itself may be stored by any shared cache in between.
const NO_STORE = "private, no-store";

function fileHeaders(file: { mime: string; title: string; bytes: number }, download: boolean): Record<string, string> {
  return {
    "Content-Type": file.mime,
    "Content-Disposition": contentDispositionHeader(download ? "attachment" : "inline", file.title),
    "Content-Length": String(file.bytes),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": NO_STORE,
  };
}

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": NO_STORE } });
}

// This is what the glossary calls an "API route": unlike a page.tsx file
// (which returns JSX describing something to look at), a route.ts file
// returns raw data, a file, or (as here) a redirect. Exporting a function
// specifically named `GET` is a Next.js convention that makes it handle
// GET requests -- the kind of request a browser sends when simply visiting
// a link or an <a>/<iframe> tag points here.
export async function GET(request: NextRequest, { params }: RouteContext) {
  const startedAt = Date.now();
  const { fileId } = await params;
  const download = request.nextUrl.searchParams.get("dl") === "1";
  const bucket = download ? "download" : "view";
  const visitor = identifyVisitor(request.cookies.get(VISITOR_COOKIE)?.value, request.headers.get("x-forwarded-for"));
  const logFields = { fileId, kind: bucket, ...visitorLogFields(visitor, request.headers.get("user-agent")) };

  // Not even shaped like a file id: no need to ask the database.
  if (!isUuid(fileId)) {
    logEvent("file", { outcome: "not_found", reason: "invalid_id", ...logFields });
    return withVisitorCookie(notFound(), visitor);
  }

  // Checked before doing any work, so a visitor over their limit costs
  // nothing more than this.
  const limit = rateLimit(bucket, visitor, fileId);
  if (!limit.allowed) {
    logEvent("rate_limited", { bucket, scope: limit.scope, retryAfterSeconds: limit.retryAfterSeconds, ...logFields });
    return withVisitorCookie(rateLimitedResponse(request, limit), visitor);
  }

  const file = await getFileForDownload(fileId);
  if (!file) {
    logEvent("file", { outcome: "not_found", ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(notFound(), visitor);
  }

  const storage = getStorageProvider();

  if (storage.presignedGetUrl) {
    const url = await storage.presignedGetUrl(file.storageKey, PRESIGNED_LINK_SECONDS);
    // The file is being handed out, so now it counts -- once per distinct
    // file, however many times the visitor comes back to it.
    limit.record();
    logEvent("file", { outcome: "redirect", bytes: file.bytes, ms: Date.now() - startedAt, ...logFields });
    // 302 "Found": the browser immediately requests `url` instead.
    return withVisitorCookie(
      NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": NO_STORE } }),
      visitor
    );
  }

  // Local storage: stream the file through this route, a piece at a time
  // rather than loading it all into memory first.
  const stream = await storage.getStream(file.storageKey);
  if (!stream) {
    logEvent("file", { outcome: "missing_in_storage", ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(notFound(), visitor);
  }
  limit.record();
  logEvent("file", { outcome: "streamed", bytes: file.bytes, ms: Date.now() - startedAt, ...logFields });
  return withVisitorCookie(
    new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: fileHeaders(file, download),
    }),
    visitor
  );
}

/**
 * A HEAD request asks only for a file's headers (some download managers
 * and link-preview bots send one first). It's answered from the database
 * alone and never counts towards any limit -- so it also never hands out
 * a presigned link (that would be a way round the limit).
 */
export async function HEAD(request: NextRequest, { params }: RouteContext) {
  const { fileId } = await params;
  if (!isUuid(fileId)) return new NextResponse(null, { status: 404 });
  const file = await getFileForDownload(fileId);
  if (!file) return new NextResponse(null, { status: 404 });
  const download = request.nextUrl.searchParams.get("dl") === "1";
  return new NextResponse(null, { status: 200, headers: fileHeaders(file, download) });
}
