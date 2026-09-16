import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { NextResponse } from "next/server";
import { ZipArchive } from "archiver";
import pLimit from "p-limit";
import { listPublishedFilesForInstance, type DownloadableYearFile } from "@/lib/db/queries";
import { getStorageProvider, type StorageProvider } from "@/lib/storage";
import { generateDownloadFilename, sanitizeForFilename } from "@/lib/artifact-naming";
import { seriesDisplayLabel } from "@/lib/format";

/**
 * At most this many files are being read from storage at once. archiver
 * still writes zip entries strictly in append order regardless (one
 * source stream fully drained before the next starts), so this doesn't
 * buy read/write parallelism -- what it bounds is how many R2 GetObject
 * requests/open connections can be outstanding at once for a large year,
 * instead of firing every file's request simultaneously.
 */
const READ_CONCURRENCY = 4;

/**
 * Streams one file from storage straight into the archive and resolves
 * once archiver has fully drained it (not merely queued it) -- that's
 * what makes the p-limit slot above a meaningful cap on open streams
 * rather than one that frees the instant `.append()` returns. Returns
 * normally without appending anything if the file is missing from
 * storage (DB/storage drift) -- logged and skipped, not a fatal error,
 * matching this route's original buffered version.
 */
async function appendFile(storage: StorageProvider, archive: ZipArchive, file: DownloadableYearFile): Promise<void> {
  const stream = await storage.getStream(file.storageKey);
  if (!stream) {
    console.warn(`[download-year] skipping ${file.storageKey}: missing from storage`);
    return;
  }
  archive.append(stream, { name: generateDownloadFilename(file.title) });
  await finished(stream);
}

/**
 * Bundles every published artifact for one (series, year) into a single
 * zip, for the "Download all" button on the year browse page. Runs on the
 * default Node.js runtime (zip generation needs Node; Edge can't do this).
 *
 * Each file streams from storage straight into its zip entry -- neither
 * a single file nor the zip's own compressed output is ever buffered
 * whole in memory. `ZipArchive` is a `stream.Transform`, so its bytes
 * flow straight into the HTTP response as archiver produces them.
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

  // A file-level error (a real storage failure, not the soft "missing"
  // case handled inside appendFile) aborts the whole zip rather than
  // producing a silently truncated one -- destroying `archive` here
  // propagates as an error on the response stream, which ends the
  // connection instead of completing it, so the client sees a failed
  // download rather than a corrupt file that looks complete.
  const archiveError = new Promise<never>((_, reject) => {
    archive.once("error", reject);
  });

  (async () => {
    try {
      const limit = pLimit(READ_CONCURRENCY);
      await Promise.race([
        Promise.all(files.map((file) => limit(() => appendFile(storage, archive, file)))),
        archiveError,
      ]);
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
