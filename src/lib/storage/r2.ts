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
 * Saves files to Cloudflare's cloud storage (called "R2"). R2 works the
 * same way as Amazon's S3 storage service, so this just uses Amazon's own
 * toolkit, pointed at Cloudflare's address instead of Amazon's — there's
 * no need for a separate Cloudflare-specific toolkit. This gets used when
 * STORAGE_BACKEND is set to "r2"; see src/lib/storage/index.ts for how the
 * settings in .env.example get turned into the config below.
 *
 * The optional `client` parameter lets tests substitute a fake stand-in
 * for the real connection, so tests can run without actually talking to
 * Cloudflare — see src/lib/storage/r2.test.ts.
 */
export class R2Storage implements StorageProvider {
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
   * The cloud storage toolkit's types say the response body could be a few
   * different kinds of stream, since the same toolkit also runs in web
   * browsers. But this app only ever runs on a plain Node.js server, which
   * always gives back one specific, well-understood kind of stream. We
   * double-check that assumption here (rather than just assuming it's
   * true), so that if a future update ever changes that behavior, we get a
   * clear error message here instead of a confusing failure somewhere else.
   */
  async getStream(key: string): Promise<Readable | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      if (!(result.Body instanceof Readable)) {
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
    // This isn't a web address you can open directly in a browser (the
    // storage bucket isn't set up for public access). Files are instead
    // served through our own /api/files/[fileId] route, which re-checks
    // whether the paper is still allowed to be downloaded every single
    // time it's requested. We deliberately don't use a temporary
    // "presigned" direct link here, because that kind of link would keep
    // working for a while even after a paper's rights status changed —
    // see src/lib/storage/index.ts for more on why.
    return `r2://${this.bucket}/${key}`;
  }
}
