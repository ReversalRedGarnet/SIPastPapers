import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { PutResult, StorageProvider } from "./types";

export interface R2StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
}

function isNotFoundError(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Cloudflare R2 implementation of StorageProvider (spec section 5). R2 is
 * S3-compatible, so this is just the AWS SDK's S3 client pointed at R2's
 * endpoint (https://<account-id>.r2.cloudflarestorage.com) with R2 API
 * token credentials — no R2-specific SDK needed. Selected via
 * STORAGE_BACKEND=r2; see src/lib/storage/index.ts for how the env vars
 * in .env.example map to R2StorageConfig.
 *
 * The `client` parameter exists so tests can inject a fake S3Client
 * (anything with a matching `send()`) instead of talking to real R2 —
 * see src/lib/storage/r2.test.ts.
 */
export class R2Storage implements StorageProvider {
  // `Pick<S3Client, "send">` is a "utility type": instead of writing a
  // brand-new type by hand, it builds one automatically from an existing
  // type (S3Client) by keeping only the named piece(s) -- here, just the
  // `send` method. This class only ever calls `.send(...)`, so it asks for
  // exactly that, which is also what lets tests substitute a much simpler
  // fake object in place of a real S3Client (see the comment above).
  private readonly client: Pick<S3Client, "send">;
  private readonly bucket: string;

  constructor(config: R2StorageConfig, client?: Pick<S3Client, "send">) {
    this.bucket = config.bucketName;
    this.client =
      client ??
      new S3Client({
        region: "auto",
        endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      });
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<PutResult> {
    console.log(`[r2] PUT bucket="${this.bucket}" key="${key}" bytes=${data.byteLength} contentType="${contentType ?? ""}"`);
    const response = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
      })
    );
    console.log(
      `[r2] PUT response httpStatusCode=${response.$metadata?.httpStatusCode} requestId=${response.$metadata?.requestId} ` +
        `ETag=${response.ETag} versionId=${response.VersionId}`
    );
    return { key, bytes: data.byteLength };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      const bytes = await result.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * `result.Body` is typed as `Readable | ReadableStream | Blob`
   * (`StreamingBlobPayloadOutputTypes`) because the AWS SDK also runs in
   * browsers/Workers, but this app only ever runs the Node.js request
   * handler, which always hands back a Node `Readable` -- checked rather
   * than blindly cast, so a future SDK/runtime change fails loudly here
   * instead of producing a stream `.append()` can't actually read.
   */
  async getStream(key: string): Promise<Readable | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      if (!(result.Body instanceof Readable)) {
        // `typeof` here is a *runtime* JavaScript check ("what kind of
        // value is this while the program is actually running?") -- a
        // different thing from a TypeScript type annotation like `: string`,
        // which only exists before the code runs, to catch mistakes early.
        throw new Error(`R2 GetObject for "${key}" returned a non-Node stream body (got ${typeof result.Body})`);
      }
      return result.Body;
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  locate(key: string): string {
    // Not a browser-loadable URL (the bucket isn't configured for public
    // access) — objects are served by proxying bytes through
    // /api/files/[fileId] (see that route), which re-checks the
    // artifact's rights/publication status on every request. A presigned
    // URL would remain valid for its TTL even after a rights change, so
    // it isn't used here; see src/lib/storage/index.ts for the fuller
    // rationale.
    return `r2://${this.bucket}/${key}`;
  }
}
