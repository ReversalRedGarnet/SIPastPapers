import type { Readable } from "node:stream";

/**
 * This describes the shared interface that any storage system (a place to
 * save and retrieve uploaded files) must follow.
 *
 * The rest of the app only ever talks to this interface, never to a
 * specific storage system directly. There are two actual implementations:
 * local-fs.ts (saves files on the local disk — the default, no cloud
 * account needed) and r2.ts (saves files to Cloudflare's cloud storage).
 * getStorageProvider() in ./index.ts picks which one to use based on a
 * setting, so the rest of the app doesn't need to know or care which one
 * is actually being used.
 */

export interface PutResult {
  key: string;
  bytes: number;
}

// An interface (see src/types/domain.ts) can describe required *methods*
// (actions something must be able to perform), not just plain data fields.
// This says "anything claiming to be a StorageProvider must provide a
// put/get/getStream/exists/delete/locate function with exactly these
// inputs and outputs" -- without saying anything about *how* each one
// actually works. local-fs.ts and r2.ts below are two very different
// implementations of this same shared contract.
export interface StorageProvider {
  /** Saves the given bytes under `key`. It's up to whoever calls this to avoid accidentally overwriting an existing file. */
  // `contentType?: string` -- a `?` on a function parameter (as opposed to
  // an object field, see src/app/results/page.tsx) means this argument is
  // optional: callers can leave it out entirely.
  put(key: string, data: Buffer, contentType?: string): Promise<PutResult>;

  /** Reads the full contents saved at `key`, or returns null if nothing is there. */
  get(key: string): Promise<Buffer | null>;

  /**
   * Same as get(), but delivers the contents as a stream instead of one
   * big chunk. Useful when something wants to pass the file's bytes along
   * (say, into a zip download) without having to hold the entire file in
   * memory at once. Use get() instead when you genuinely need the whole
   * file as one Buffer (like when calculating a file's fingerprint/hash).
   */
  getStream(key: string): Promise<Readable | null>;

  /** Checks whether something is saved at `key`. */
  exists(key: string): Promise<boolean>;

  /** Deletes whatever is saved at `key`. Should only be used for a deliberate, tracked correction — never as a routine way to overwrite a file. */
  delete(key: string): Promise<void>;

  /** Returns something that can be used to build a download/view link for this file. Not guaranteed to be a public web address for every storage system. */
  locate(key: string): string;
}

/**
 * Builds the standard file path used to save an exam paper, always in
 * this shape:
 *   archive/{exam-series}/{year}/{subject-slug}/{artifact-type}/{canonical-file}.pdf
 *
 * The file name is always generated from the paper's own details (exam
 * series, year, subject, etc.) — never taken from whatever the uploaded
 * file happened to be named. The original uploaded file name is kept
 * separately, just as a record of where it came from; it isn't used here.
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
