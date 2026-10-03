/**
 * Test helper: a hand-written fake stand-in for the R2 (S3) connection --
 * just enough to handle the commands R2Storage sends, backed by an
 * in-memory map. No real cloud account, credentials or network access is
 * needed. Shared by src/lib/storage/r2.test.ts and the database tests.
 */
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { R2Storage } from "./r2";

function notFoundError(name: string, httpStatusCode = 404) {
  const err = new Error(`${name} error`);
  (err as { name?: string }).name = name;
  (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  return err;
}

interface FakeObject {
  body: Buffer;
  contentType?: string;
  contentDisposition?: string;
  cacheControl?: string;
}

/** Like R2/S3, a single-upload object's ETag is the quoted MD5 of its bytes. */
function etagOf(body: Buffer): string {
  return `"${createHash("md5").update(body).digest("hex")}"`;
}

/** A stand-in for the real cloud storage connection — just an in-memory list of saved files. */
export function createFakeS3Client() {
  const objects = new Map<string, FakeObject>();

  const client = {
    objects,
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const { Key, Body, ContentType, ContentDisposition, CacheControl, IfNoneMatch } = command.input;
        // Like real R2: "If-None-Match: *" makes the write fail with 412
        // when something is already stored at this key.
        if (IfNoneMatch === "*" && objects.has(Key!)) throw notFoundError("PreconditionFailed", 412);
        objects.set(Key!, {
          body: Buffer.from(Body as Buffer),
          contentType: ContentType,
          contentDisposition: ContentDisposition,
          cacheControl: CacheControl,
        });
        return {};
      }
      if (command instanceof CopyObjectCommand) {
        const { Bucket, Key, CopySource, CopySourceIfMatch, MetadataDirective } = command.input;
        const sourceKey = decodeURIComponent(CopySource!.slice(`${Bucket}/`.length));
        const source = objects.get(sourceKey);
        if (!source) throw notFoundError("NoSuchKey");
        if (CopySourceIfMatch && CopySourceIfMatch !== etagOf(source.body)) {
          throw notFoundError("PreconditionFailed", 412);
        }
        // REPLACE: the copy gets exactly the headers sent with this
        // request -- anything not re-sent is dropped, as on real R2.
        objects.set(
          Key!,
          MetadataDirective === "REPLACE"
            ? {
                body: source.body,
                contentType: command.input.ContentType,
                contentDisposition: command.input.ContentDisposition,
                cacheControl: command.input.CacheControl,
              }
            : { ...source }
        );
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const obj = objects.get(command.input.Key!);
        if (!obj) throw notFoundError("NoSuchKey");
        // A real Node.js stream, matching what the actual cloud storage
        // toolkit hands back in this app. We also attach
        // transformToByteArray here so the get() method's simpler,
        // whole-file-at-once code path keeps working in these tests too.
        const body = Readable.from(obj.body) as Readable & { transformToByteArray: () => Promise<Uint8Array> };
        body.transformToByteArray = async () => new Uint8Array(obj.body);
        return { Body: body };
      }
      if (command instanceof HeadObjectCommand) {
        const obj = objects.get(command.input.Key!);
        if (!obj) throw notFoundError("NotFound");
        return {
          ContentType: obj.contentType,
          ContentDisposition: obj.contentDisposition,
          CacheControl: obj.cacheControl,
          ContentLength: obj.body.byteLength,
          ETag: etagOf(obj.body),
        };
      }
      if (command instanceof DeleteObjectCommand) {
        objects.delete(command.input.Key!);
        return {};
      }
      throw new Error(`Unhandled command in fake S3 client: ${(command as { constructor: { name: string } }).constructor.name}`);
    },
  };

  return client;
}

/** An R2Storage that talks to `client` (by default a fresh fake bucket) instead of real R2. */
export function fakeR2Storage(client: Pick<ReturnType<typeof createFakeS3Client>, "send"> = createFakeS3Client()): R2Storage {
  return new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    client
  );
}
