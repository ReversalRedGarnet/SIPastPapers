import path from "node:path";
import { LocalFilesystemStorage } from "./local-fs";
import { R2Storage } from "./r2";
import type { StorageProvider } from "./types";

// "Re-exporting": this file passes StorageProvider/PutResult/buildStorageKey
// straight through from ./types, without using them itself, purely so
// other files can `import { buildStorageKey } from "@/lib/storage"` (this
// file) instead of having to know it actually lives in a different,
// more specific file.
export type { StorageProvider, PutResult } from "./types";
export { buildStorageKey } from "./types";

let instance: StorageProvider | undefined;

// `process.env` holds every environment variable available to this
// running program (see the glossary in HOW-THIS-APP-WORKS.md). Writing
// `process.env[name]` -- square brackets with a variable inside -- looks
// up whichever variable name is currently stored in `name`, which lets
// this one function work for any environment variable name a caller asks
// for, rather than being hard-coded to check one specific name.
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name} for STORAGE_BACKEND=r2 (see .env.example).`
    );
  }
  return value;
}

/**
 * Returns whichever storage system is currently active, based on the
 * STORAGE_BACKEND setting:
 *   - "local" (the default) — saves files on the local disk, in the
 *     local-storage/ folder. Needs no setup, so local development and
 *     the test suite work with no extra configuration.
 *   - "r2" — saves files to Cloudflare's cloud storage instead. This
 *     requires four settings to be filled in (R2_ACCOUNT_ID,
 *     R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME — see
 *     .env.example). If any of them are missing, this fails immediately
 *     with a clear error, rather than quietly falling back to saving
 *     files locally where nobody would find them.
 *
 * Next.js automatically loads settings from .env.local when running the
 * app. The command-line tool loads that file itself, since it runs
 * outside of Next.js.
 */
export function getStorageProvider(): StorageProvider {
  if (instance) return instance;

  const backend = process.env.STORAGE_BACKEND ?? "local";

  if (backend === "r2") {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    const bucketName = requireEnv("R2_BUCKET_NAME");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
    // Logs which storage backend actually ended up being used, so it's
    // easy to confirm at a glance. This only prints once (the result gets
    // cached above), not on every single request. It never logs the secret
    // access key itself — just the last 4 characters of the access key ID,
    // which is enough to tell two different accounts apart in the logs
    // without exposing anything sensitive.
    console.log(
      `[storage] STORAGE_BACKEND=r2 -> R2Storage (bucket="${bucketName}", accountId="${accountId}", ` +
        `endpoint="https://${accountId}.r2.cloudflarestorage.com", accessKeyId="...${accessKeyId.slice(-4)}")`
    );
    instance = new R2Storage({
      accountId,
      accessKeyId,
      secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
      bucketName,
    });
  } else if (backend === "local") {
    // This can be overridden so the test suite can point at a separate,
    // temporary folder instead of the real local-storage/ folder. It's
    // left unset during normal everyday use.
    const root = process.env.SIPASTPAPERS_STORAGE_ROOT
      ? path.resolve(process.env.SIPASTPAPERS_STORAGE_ROOT)
      : path.join(process.cwd(), "local-storage");
    console.log(`[storage] STORAGE_BACKEND=${backend} -> LocalFilesystemStorage (root="${root}")`);
    instance = new LocalFilesystemStorage(process.env.SIPASTPAPERS_STORAGE_ROOT ? root : undefined);
  } else {
    throw new Error(`Unknown STORAGE_BACKEND: "${backend}" (expected "local" or "r2")`);
  }

  return instance;
}
