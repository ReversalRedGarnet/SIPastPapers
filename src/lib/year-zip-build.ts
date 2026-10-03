import { ZipArchive } from "archiver";
import type { StorageProvider } from "@/lib/storage";
import { listPublishedFilesForInstance, type DownloadableYearFile } from "@/lib/db/queries";
import { yearZipEntryName, yearZipKey, yearZipPrefix, yearZipServingHeaders } from "@/lib/year-zip";

/**
 * Building and storing a year's zip -- used only by the CLI (build-zips)
 * and tests, never by the website. See src/lib/year-zip.ts for how zips
 * are named and served.
 */

/**
 * Builds the zip in memory (a year is at most ~40 MB). Every PDF goes in
 * as-is (`store: true`): they're already compressed, so compressing again
 * saves almost nothing. Unlike the old live-built zip, a file missing from
 * storage is an error, not skipped -- a zip's key promises exactly which
 * files are inside.
 */
export async function buildYearZipBuffer(storage: StorageProvider, files: DownloadableYearFile[]): Promise<Buffer> {
  const archive = new ZipArchive({ store: true });
  const chunks: Buffer[] = [];
  archive.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve, reject) => {
    archive.once("end", resolve);
    archive.once("error", reject);
  });
  for (const file of files) {
    const bytes = await storage.get(file.storageKey);
    if (!bytes) {
      archive.abort();
      throw new Error(`${file.storageKey} is missing from storage -- not building a zip without it`);
    }
    archive.append(bytes, { name: yearZipEntryName(file) });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

export interface YearZipStatus {
  seriesCode: string;
  year: number;
  /** The files that are servable right now -- what the zip should hold. */
  files: DownloadableYearFile[];
  /** The key the website will look for; null when nothing in this year is servable. */
  key: string | null;
  /** Whether that zip is already stored. */
  built: boolean;
  /** Zips stored for this year that no longer match (safe to delete). */
  staleKeys: string[];
}

export async function getYearZipStatus(storage: StorageProvider, seriesCode: string, year: number): Promise<YearZipStatus> {
  const [files, stored] = await Promise.all([
    listPublishedFilesForInstance(seriesCode, year),
    storage.list(yearZipPrefix(seriesCode, year)),
  ]);
  const key = files.length > 0 ? yearZipKey(seriesCode, year, files) : null;
  return {
    seriesCode,
    year,
    files,
    key,
    built: key !== null && stored.includes(key),
    staleKeys: stored.filter((k) => k !== key),
  };
}

/**
 * Makes the stored zip match `status`: builds and stores it if missing
 * (with its download name and caching headers), then deletes any stale
 * zips for the year. Returns the size of a newly built zip (0 if it was
 * already there).
 */
export async function syncYearZip(storage: StorageProvider, status: YearZipStatus): Promise<{ bytes: number; deleted: string[] }> {
  let bytes = 0;
  if (status.key && !status.built) {
    const zip = await buildYearZipBuffer(storage, status.files);
    await storage.put(status.key, zip, yearZipServingHeaders(status.seriesCode, status.year));
    bytes = zip.byteLength;
  }
  // Only after the new zip is safely stored, so a year never goes without
  // one because of a failed build.
  for (const key of status.staleKeys) await storage.delete(key);
  return { bytes, deleted: status.staleKeys };
}
