import type { Readable } from "node:stream";

/**
 * Storage abstraction per PROJECT_SPEC.md section 5.1.
 *
 * The rest of the app should depend only on this interface, never on a
 * concrete provider. Two implementations exist — local-fs.ts
 * (filesystem, the default, no cloud dependency) and r2.ts (Cloudflare
 * R2) — selected by getStorageProvider() in ./index.ts based on
 * STORAGE_BACKEND, without any caller needing to know which is active.
 */

export interface PutResult {
  key: string;
  bytes: number;
}

export interface StorageProvider {
  /** Write bytes under `key`. Overwrites are the caller's responsibility to avoid — see section 5.3. */
  put(key: string, data: Buffer, contentType?: string): Promise<PutResult>;

  /** Read the full contents stored at `key`, or null if it doesn't exist. */
  get(key: string): Promise<Buffer | null>;

  /**
   * Read the contents stored at `key` as a stream, or null if it doesn't
   * exist — for a caller that wants to pipe bytes onward (e.g. into a zip
   * entry) without holding the whole file in memory. `get()` remains the
   * right choice for a caller that genuinely needs the full Buffer (sha256
   * hashing at ingest time, etc.); this doesn't replace it.
   */
  getStream(key: string): Promise<Readable | null>;

  /** Whether an object exists at `key`. */
  exists(key: string): Promise<boolean>;

  /** Remove the object at `key`. Should only be used for explicit, logged corrections — never routine overwrite. */
  delete(key: string): Promise<void>;

  /** A locator for the object suitable for building a download/view link. Not guaranteed to be a public URL for every provider. */
  locate(key: string): string;
}

/**
 * Canonical storage key layout per section 5.2:
 *   archive/{exam-series}/{year}/{subject-slug}/{artifact-type}/{canonical-file}.pdf
 *
 * File names must be derived from canonical metadata, not from the
 * uploaded file's original name (section 5.2). The original filename is
 * kept separately as provenance metadata, not used here.
 */
export function buildStorageKey(params: {
  examSeriesSlug: string;
  year: number;
  subjectSlug: string;
  artifactType: string;
  fileName: string;
}): string {
  const { examSeriesSlug, year, subjectSlug, artifactType, fileName } = params;
  return `archive/${examSeriesSlug}/${year}/${subjectSlug}/${artifactType}/${fileName}`;
}
