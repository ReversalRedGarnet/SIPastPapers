import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import type { PutResult, StorageProvider } from "./types";

/**
 * Local filesystem implementation of StorageProvider (section 5.1).
 * Stores files under `<repo root>/local-storage/<key>`. The default
 * backend (STORAGE_BACKEND=local, or unset) — see r2.ts for the
 * Cloudflare R2 alternative.
 */
// A `class` is a template for creating objects that bundle related data
// together with the functions that act on it. `implements StorageProvider`
// is a promise to the type checker: "this class provides every method
// StorageProvider requires" (see types.ts) -- if one were missing,
// TypeScript would refuse to compile.
export class LocalFilesystemStorage implements StorageProvider {
  // A field declared on a class exists on every object created from it.
  // `private` means only code inside this class can access `rootDir`
  // directly; `readonly` means it can be set once (in the constructor
  // below) and never reassigned afterward.
  private readonly rootDir: string;

  // The `constructor` is a special method that runs once, automatically,
  // whenever someone writes `new LocalFilesystemStorage(...)` to create a
  // new instance. Its `rootDir: string = path.join(...)` parameter has a
  // default value (see src/lib/db/client.ts), so callers can leave it out
  // and get the ordinary local-storage folder.
  constructor(rootDir: string = path.join(process.cwd(), "local-storage")) {
    // `this` refers to "the specific object being constructed right now" --
    // this line saves the given rootDir onto that object's own `rootDir`
    // field, so every other method below (which also uses `this.rootDir`)
    // can read it back later.
    this.rootDir = rootDir;
  }

  private resolve(key: string): string {
    const normalized = path.normalize(key).replace(/^([.]{2}[/\\])+/, "");
    const full = path.join(this.rootDir, normalized);
    if (!full.startsWith(this.rootDir)) {
      throw new Error(`Refusing to write outside storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, data: Buffer): Promise<PutResult> {
    const dest = this.resolve(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    return { key, bytes: data.byteLength };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  /**
   * Existence is checked upfront (rather than letting createReadStream's
   * async 'error' event surface ENOENT) so this matches get()'s
   * Promise<Readable | null> contract instead of an error-emitting stream.
   */
  async getStream(key: string): Promise<Readable | null> {
    const resolved = this.resolve(key);
    try {
      await fs.access(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return createReadStream(resolved);
  }

  // `catch` doesn't have to capture the error into a variable if the code
  // doesn't need to look at it -- here, any failure at all just means
  // "doesn't exist," so there's nothing about the specific error worth
  // reading.
  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  locate(key: string): string {
    // No public web server route exposes /local-storage — this is a
    // developer-facing path, not a browser-loadable URL. A real download
    // route would stream from a StorageProvider rather than serving this
    // directory directly.
    return `local-storage/${key}`;
  }
}
