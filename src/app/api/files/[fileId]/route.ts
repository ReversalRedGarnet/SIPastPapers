import { NextResponse, type NextRequest } from "next/server";
import { getFileForDownload } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { generateDownloadFilename } from "@/lib/artifact-naming";

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
 * PDF viewing behavior).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const { fileId } = await params;
  const file = await getFileForDownload(fileId);
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
      // A paper's rights/publication status can change at any moment, so
      // we tell browsers and any in-between servers never to cache this
      // file — they must always check back with us fresh, rather than
      // serving an old, possibly-no-longer-allowed copy.
      "Cache-Control": "no-store",
    },
  });
}
