import { constants as fsConstants, createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { StorageKeyExistsError, type PutResult, type StorageProvider } from "./types";

/**
 * Saves files on the local disk, under `<project folder>/local-storage/<key>`.
 * This is the default storage option (used when STORAGE_BACKEND is set to
 * "local", or not set at all) — see r2.ts for the cloud-storage alternative.
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
    try {
      // The "wx" flag means "create this file, but fail if it already
      // exists" -- checked by the operating system in the same step as the
      // write, so there's no gap in which another write could sneak in.
      await fs.writeFile(dest, data, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new StorageKeyExistsError(key);
      throw err;
    }
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
   * We check whether the file exists first, rather than waiting for the
   * stream itself to report an error if it's missing. That way, this
   * behaves consistently with get() above: it returns null when the file
   * doesn't exist, rather than throwing an error partway through.
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

  async list(prefix: string): Promise<string[]> {
    // Look only in the folder the prefix points into, then keep the keys
    // that actually start with the prefix (it may end part-way through a
    // name, e.g. "zips/sisc-l1/20").
    const dir = this.resolve(prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : ".");
    let entries: string[];
    try {
      entries = await fs.readdir(dir, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const keys: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (!(await fs.stat(full)).isFile()) continue;
      const key = path.relative(this.rootDir, full).split(path.sep).join("/");
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  async copy(fromKey: string, toKey: string): Promise<void> {
    const dest = this.resolve(toKey);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      // COPYFILE_EXCL: fail rather than replace an existing file.
      await fs.copyFile(this.resolve(fromKey), dest, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new StorageKeyExistsError(toKey);
      throw err;
    }
  }

  locate(key: string): string {
    // This path isn't reachable from a web browser — there's no public web
    // address that serves files straight out of the local-storage folder.
    // This is just an internal reference for developers. A real download
    // feature would read the file through the storage system above (and
    // send it to the browser itself), rather than exposing this folder
    // directly.
    return `local-storage/${key}`;
  }
}
