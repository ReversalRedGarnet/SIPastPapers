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
