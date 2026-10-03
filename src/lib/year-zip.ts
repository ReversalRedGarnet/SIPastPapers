import { createHash } from "node:crypto";
import { contentDispositionForFilename, generateDownloadFilename, sanitizeForFilename } from "@/lib/artifact-naming";
import { seriesDisplayLabel } from "@/lib/format";
import { PDF_CACHE_CONTROL, type ServingHeaders } from "@/lib/storage/serving-headers";
import type { StorageProvider } from "@/lib/storage";

/**
 * Prebuilt "download all" zips, one per exam series + year, stored in R2
 * and handed out by /api/download-year the same way PDFs are: a live
 * rights check, then a redirect to a short-lived link. A zip is built
 * ahead of time by the CLI (build-zips), never by the website, so its
 * 20-40 MB never pass through Vercel.
 *
 * A zip's key names exactly what's inside it:
 *   zips/<series>/<year>/<fingerprint>.zip
 * where the fingerprint covers every file in it (id, sha256 and its name
 * in the zip). The website works out the fingerprint from the files that
 * are servable *right now* and serves only the zip with that key -- so
 * once a paper is withdrawn, replaced or added, an older zip of that year
 * simply stops matching and is never handed out again, and a zip can
 * never include a paper that isn't currently allowed.
 */

export interface YearZipFile {
  fileId: string;
  sha256: string;
  title: string;
}

export const YEAR_ZIP_ROOT = "zips/";

/** Every zip ever built for one series + year is stored under this. */
export function yearZipPrefix(seriesCode: string, year: number): string {
  return `${YEAR_ZIP_ROOT}${seriesCode}/${year}/`;
}

/** A file's name inside the zip -- the same readable name it downloads with on its own. */
export function yearZipEntryName(file: YearZipFile): string {
  return generateDownloadFilename(file.title);
}

/** The key of the zip holding exactly these files (in any order). */
export function yearZipKey(seriesCode: string, year: number, files: YearZipFile[]): string {
  const manifest = files
    .map((f) => [f.fileId, f.sha256, yearZipEntryName(f)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // "v" lets the format change later (e.g. how files are named inside)
  // without an old zip ever matching a new fingerprint.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ v: 1, seriesCode, year, files: manifest }))
    .digest("hex")
    .slice(0, 32);
  return `${yearZipPrefix(seriesCode, year)}${fingerprint}.zip`;
}

/** e.g. "Form 5 - Year 11 2019.zip" -- what the visitor's download is called (as before prebuilt zips). */
export function yearZipFilename(seriesCode: string, year: number): string {
  return `${sanitizeForFilename(seriesDisplayLabel(seriesCode))} ${year}.zip`;
}

/** The headers stored with a year's zip in R2 (sent back on every download from it). */
export function yearZipServingHeaders(seriesCode: string, year: number): ServingHeaders {
  return {
    contentType: "application/zip",
    contentDisposition: contentDispositionForFilename("attachment", yearZipFilename(seriesCode, year)),
    cacheControl: PDF_CACHE_CONTROL,
  };
}

/**
 * Deletes every zip stored for one series + year. Unpublish uses this so a
 * withdrawn paper can't be downloaded inside a year's zip either -- not
 * even through a link handed out a few minutes earlier. Returns the keys
 * deleted.
 */
export async function deleteYearZips(storage: StorageProvider, seriesCode: string, year: number): Promise<string[]> {
  const keys = await storage.list(yearZipPrefix(seriesCode, year));
  for (const key of keys) await storage.delete(key);
  return keys;
}
