import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { listPublishedFilesForInstance } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { PRESIGNED_LINK_SECONDS } from "@/lib/storage/serving-headers";
import { yearZipKey, yearZipServingHeaders } from "@/lib/year-zip";
import { seriesDisplayLabel } from "@/lib/format";
import { identifyVisitor, rateLimit, VISITOR_COOKIE } from "@/lib/rate-limit";
import { rateLimitedResponse, withVisitorCookie } from "@/lib/rate-limit-response";
import { escapeHtml, noticePage, wantsHtml } from "@/lib/notice-page";
import { logEvent, visitorLogFields } from "@/lib/log";

/**
 * The "Download all" button on a year's browse page: every servable paper
 * for one exam series and year, as one zip.
 *
 * The zip is never built here. The CLI builds it ahead of time
 * (`build-zips`) and stores it in R2; on every request this route:
 *
 *   1. checks the visitor's allowance (src/lib/rate-limit.ts),
 *   2. lists, fresh from the database, the files of that year that may be
 *      served right now (published, rights currently approved, current
 *      file -- the same rule as for single PDFs),
 *   3. works out the key of the zip holding exactly those files (see
 *      src/lib/year-zip.ts) and, if it's stored, sends the browser on to a
 *      temporary link to it, valid for 10 minutes.
 *
 * So the 20-40 MB never pass through the app, and a zip that includes a
 * paper no longer allowed (or misses one just added) is never handed out:
 * its key no longer matches. If the matching zip hasn't been built yet,
 * the visitor gets a 503 explaining that, and it's logged.
 *
 * With local storage (development) the stored zip is streamed through this
 * route instead.
 */

const NO_STORE = "private, no-store";

/** Matches how long a visitor is told to wait before trying again. */
const NOT_READY_RETRY_AFTER_SECONDS = 3600;

function notFound(): NextResponse {
  return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": NO_STORE } });
}

function zipNotReadyResponse(request: NextRequest, seriesCode: string, year: number): NextResponse {
  const label = `${seriesDisplayLabel(seriesCode)} ${year}`;
  const headers = { "Retry-After": String(NOT_READY_RETRY_AFTER_SECONDS), "Cache-Control": NO_STORE };
  if (wantsHtml(request)) {
    const html = noticePage(
      request,
      "Download not ready yet",
      `The zip of all ${escapeHtml(label)} papers isn&#39;t ready yet`,
      `<p>The papers for this year were updated recently, and the download of all of them together is still being prepared.</p>
  <p><strong>Please try again later.</strong> In the meantime, every paper can still be opened one at a time from the year&#39;s page.</p>`
    );
    return new NextResponse(html, { status: 503, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  }
  return NextResponse.json(
    { error: `The zip of all ${label} papers isn't ready yet. Please try again later.` },
    { status: 503, headers }
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ series: string; year: string }> }
) {
  const startedAt = Date.now();
  const { series: seriesCode, year: yearParam } = await params;
  const visitor = identifyVisitor(request.cookies.get(VISITOR_COOKIE)?.value, request.headers.get("x-forwarded-for"));
  const logFields = { series: seriesCode, year: yearParam, ...visitorLogFields(visitor, request.headers.get("user-agent")) };
  const year = Number(yearParam);
  if (!/^\d{4}$/.test(yearParam)) {
    return withVisitorCookie(notFound(), visitor);
  }

  // A whole year is the biggest thing this site hands out, so it has the
  // smallest allowance (see src/lib/rate-limit.ts). Downloading the same
  // year again (e.g. retrying a failed download) counts once.
  const limit = rateLimit("zip", visitor, `${seriesCode}/${year}`);
  if (!limit.allowed) {
    logEvent("rate_limited", { bucket: "zip", scope: limit.scope, retryAfterSeconds: limit.retryAfterSeconds, ...logFields });
    return withVisitorCookie(rateLimitedResponse(request, limit), visitor);
  }

  const files = await listPublishedFilesForInstance(seriesCode, year);
  if (files.length === 0) {
    logEvent("zip", { outcome: "not_found", ...logFields });
    return withVisitorCookie(notFound(), visitor);
  }

  const storage = getStorageProvider();
  const key = yearZipKey(seriesCode, year, files);

  if (!(await storage.exists(key))) {
    // Not counted against the visitor: nothing was handed out.
    logEvent("zip", { outcome: "not_built", key, files: files.length, ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(zipNotReadyResponse(request, seriesCode, year), visitor);
  }

  if (storage.presignedGetUrl) {
    const url = await storage.presignedGetUrl(key, PRESIGNED_LINK_SECONDS);
    limit.record();
    logEvent("zip", { outcome: "redirect", key, files: files.length, ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": NO_STORE } }), visitor);
  }

  // Local storage: stream the stored zip through this route.
  const stream = await storage.getStream(key);
  if (!stream) {
    logEvent("zip", { outcome: "not_built", key, files: files.length, ms: Date.now() - startedAt, ...logFields });
    return withVisitorCookie(zipNotReadyResponse(request, seriesCode, year), visitor);
  }
  limit.record();
  logEvent("zip", { outcome: "streamed", key, files: files.length, ms: Date.now() - startedAt, ...logFields });
  const headers = yearZipServingHeaders(seriesCode, year);
  return withVisitorCookie(
    new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: 200,
      headers: {
        "Content-Type": headers.contentType,
        "Content-Disposition": headers.contentDisposition,
        "Cache-Control": NO_STORE,
      },
    }),
    visitor
  );
}
