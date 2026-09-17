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
 * The most files we'll read from storage at the same time. The zip
 * builder always writes its entries in a fixed order regardless (fully
 * finishing one file before starting the next), so this setting doesn't
 * actually make the reading or writing faster. What it does do is limit
 * how many storage requests can be open at once for a year with lots of
 * files, instead of firing off a request for every single file all at once.
 */
const READ_CONCURRENCY = 4;

/**
 * Streams one file from storage directly into the zip archive, and only
 * finishes once the file has been fully read into the archive (not just
 * queued up to be read) — that's what makes the concurrency limit above
 * actually meaningful, rather than something that frees up again the
 * instant a file is merely queued. If the file has somehow gone missing
 * from storage (a mismatch between the database and storage), this simply
 * skips it and logs a warning, rather than treating it as a fatal error —
 * matching how the earlier version of this feature behaved.
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
 * Bundles up every published exam paper for one exam series and year into
 * a single zip file, for the "Download all" button on the year browse
 * page. This needs to run on a regular Node.js server (not the lighter
 * "Edge" runtime), since building a zip file requires Node's tools.
 *
 * Each file streams straight from storage into its spot in the zip — at
 * no point is an entire file, or the whole finished zip, held all at once
 * in memory. The zip data flows directly into the response as it's
 * produced.
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

  // We check this BEFORE starting to build and send the response below —
  // not after. Once that streaming response has started, its status code
  // and headers are already locked in and sent to the visitor's browser,
  // so there's no way to go back and turn a "success" response into an
  // error after discovering partway through that nothing actually got
  // added to the zip. Without this check, if every file for this exam
  // series and year had somehow gone missing from storage while the
  // database still listed them as published (a genuine mismatch between
  // the database and storage — not the normal "no papers yet" situation),
  // the visitor would get back what looks like a successful download, but
  // is actually an empty, useless zip file, with no visible error at all.
  const existence = await Promise.all(files.map((file) => storage.exists(file.storageKey)));
  const availableFiles = files.filter((_, i) => existence[i]);
  if (availableFiles.length === 0) {
    console.error(
      `[download-year] every published file for ${seriesCode}/${year} is missing from storage (${files.length} expected)`
    );
    return new NextResponse(
      "This year's papers are temporarily unavailable. Please try again later or report the issue.",
      { status: 500 }
    );
  }

  const archive = new ZipArchive({ zlib: { level: 6 } });

  // A genuine storage failure while building the zip (not the "soft"
  // missing-file case already handled inside appendFile above) cancels
  // the whole download, rather than quietly producing a zip that looks
  // complete but is secretly missing content. Deliberately failing the
  // archive here makes the download connection end with an error, so the
  // visitor sees a failed download rather than getting a corrupted file
  // that appears fine.
  const archiveError = new Promise<never>((_, reject) => {
    archive.once("error", reject);
  });

  (async () => {
    try {
      const limit = pLimit(READ_CONCURRENCY);
      await Promise.race([
        Promise.all(availableFiles.map((file) => limit(() => appendFile(storage, archive, file)))),
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
