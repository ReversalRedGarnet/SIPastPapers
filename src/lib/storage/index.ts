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
 * Returns the active storage provider, chosen by STORAGE_BACKEND:
 *   - "local" (default) — LocalFilesystemStorage, writes under
 *     local-storage/. No configuration required, so local dev and the
 *     test suite work with zero env vars.
 *   - "r2" — Cloudflare R2 (spec section 5), via R2Storage. Requires
 *     R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and
 *     R2_BUCKET_NAME (see .env.example); missing any of them throws
 *     immediately rather than silently falling back to local storage, so
 *     a misconfigured deployment fails loudly instead of quietly writing
 *     files nobody will find.
 *
 * Next.js loads .env.local automatically for `next dev`/`build`/`start`.
 * scripts/cli.ts loads it explicitly (via process.loadEnvFile) since it
 * runs outside the Next.js runtime.
 */
export function getStorageProvider(): StorageProvider {
  if (instance) return instance;

  const backend = process.env.STORAGE_BACKEND ?? "local";

  if (backend === "r2") {
    const accountId = requireEnv("R2_ACCOUNT_ID");
    const bucketName = requireEnv("R2_BUCKET_NAME");
    const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
    // Confirms which backend actually got resolved at runtime — printed
    // once per process (this function caches `instance` after the first
    // call), not per-request. Never logs the secret access key; the
    // access key ID's last 4 chars are shown only so two different R2
    // tokens/buckets can be told apart in logs without exposing either.
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
    // Overridable so the test suite can point at an isolated temp
    // directory instead of the real local-storage/ — see
    // src/lib/db/*.test.ts and scripts/*.test.ts. Unset in normal
    // `npm run dev` / `npm run cli` usage.
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
