import { Readable } from "node:stream";
import { NextResponse } from "next/server";
import { ZipArchive } from "archiver";
import { listPublishedFilesForInstance } from "@/lib/db/queries";
import { getStorageProvider } from "@/lib/storage";
import { generateDownloadFilename, sanitizeForFilename } from "@/lib/artifact-naming";
import { seriesDisplayLabel } from "@/lib/format";

/**
 * Bundles every published artifact for one (series, year) into a single
 * zip, for the "Download all" button on the year browse page. Runs on the
 * default Node.js runtime (zip generation needs Node; Edge can't do this).
 *
 * Individual PDFs are small enough (see PROJECT_SPEC's size audit -- a few
 * MB each, ~1MB average) that fetching one fully into memory at a time is
 * fine, but the zip's own compressed output is never buffered: `ZipArchive`
 * is a `stream.Transform`, so its bytes flow straight into the HTTP
 * response as archiver produces them rather than being collected into one
 * big buffer first.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ series: string; year: string }> }
) {
  const { series: seriesCode, year: yearParam } = await params;
  const year = Number(yearParam);
  if (!Number.isInteger(year)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const files = await listPublishedFilesForInstance(seriesCode, year);
  if (files.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  const storage = getStorageProvider();
  const archive = new ZipArchive({ zlib: { level: 6 } });

  (async () => {
    try {
      for (const file of files) {
        const bytes = await storage.get(file.storageKey);
        if (!bytes) continue; // storage/DB drifted; skip rather than fail the whole zip
        archive.append(bytes, { name: generateDownloadFilename(file.title) });
      }
      await archive.finalize();
    } catch (err) {
      archive.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  const zipFilename = `${sanitizeForFilename(seriesDisplayLabel(seriesCode))} ${year}.zip`;

  return new NextResponse(Readable.toWeb(archive) as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFilename}"`,
      "Cache-Control": "no-store",
    },
  });
}
