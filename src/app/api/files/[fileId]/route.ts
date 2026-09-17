import { NextResponse, type NextRequest } from "next/server";
import { getFileForDownload } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { generateDownloadFilename } from "@/lib/artifact-naming";

/**
 * Serves the original PDF for a published artifact (spec section 3.3:
 * "direct PDF download must always work" — no JS-dependent viewer
 * required). `getFileForDownload` checks the artifact's CURRENT status on
 * every request, so a file is never served once its artifact stops being
 * "published" (rights hold, withdrawal, etc.) even if the bytes are still
 * on disk.
 *
 * `?dl=1` forces a download (Content-Disposition: attachment); otherwise
 * the browser is free to render it inline (the default PDF "view").
 */
// This is what the glossary calls an "API route": unlike a page.tsx file
// (which returns JSX describing something to look at), a route.ts file
// returns raw data or, as here, a file's actual bytes. Exporting a
// function specifically named `GET` is a Next.js convention that makes it
// handle GET requests -- the kind of request a browser sends when simply
// visiting a link or an <img>/<a> tag points here; other names (`POST`,
// `DELETE`, ...) would handle those other kinds of requests instead.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const file = await getFileForDownload(fileId);
  // `new NextResponse(...)` builds an HTTP response by hand -- a status
  // code (404 here means "not found") and a body -- which is what actually
  // gets sent back over the network to whatever asked for this address.
  if (!file) {
    return new NextResponse("Not found", { status: 404 });
  }

  const bytes = await getStorageProvider().get(file.storageKey);
  if (!bytes) {
    return new NextResponse("File is missing from storage", { status: 404 });
  }

  const download = request.nextUrl.searchParams.get("dl") === "1";
  const filename = generateDownloadFilename(file.title);

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": file.mime,
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      "Content-Length": String(file.bytes),
      "X-Content-Type-Options": "nosniff",
      // Rights/publication state can change at any time, so intermediaries
      // must always re-check rather than serving a stale cached copy.
      "Cache-Control": "no-store",
    },
  });
}
