/**
 * Tests R2Storage using a hand-written fake stand-in for the cloud storage
 * connection (just enough of it to handle save/read/check/delete
 * commands, backed by an in-memory list). No real cloud account,
 * credentials, or network access is needed to run these tests. See the
 * `client` parameter in src/lib/storage/r2.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { R2Storage } from "./r2";
import { StorageKeyExistsError } from "./types";
import { pdfServingHeaders } from "./serving-headers";

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
function createFakeS3Client() {
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

test("R2Storage put/get round-trips bytes through the (fake) bucket", async () => {
  const fake = createFakeS3Client();
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    fake
  );

  const data = Buffer.from("%PDF-1.4\n%test\n");
  const result = await storage.put("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf", data, { contentType: "application/pdf" });

  assert.equal(result.bytes, data.byteLength);
  assert.equal(result.key, "archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf");

  const readBack = await storage.get("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf");
  assert.ok(readBack);
  assert.equal(readBack!.toString(), data.toString());
});

test("R2Storage.put refuses to overwrite an existing object and leaves it untouched", async () => {
  const fake = createFakeS3Client();
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    fake
  );
  const key = "archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf";

  await storage.put(key, Buffer.from("%PDF-1.4\n%original\n"), { contentType: "application/pdf" });
  await assert.rejects(
    storage.put(key, Buffer.from("%PDF-1.4\n%replacement\n"), { contentType: "application/pdf" }),
    (err) => err instanceof StorageKeyExistsError && err.key === key
  );

  const readBack = await storage.get(key);
  assert.equal(readBack!.toString(), "%PDF-1.4\n%original\n");
});

test("R2Storage.put asks R2 itself to refuse overwrites (If-None-Match: *)", async () => {
  const sent: PutObjectCommand[] = [];
  const fake = createFakeS3Client();
  const recordingClient = {
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) sent.push(command);
      return fake.send(command);
    },
  };
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    recordingClient as unknown as ConstructorParameters<typeof R2Storage>[1]
  );

  await storage.put("a.pdf", Buffer.from("%PDF-1.4\n"));
  assert.equal(sent[0]?.input.IfNoneMatch, "*");
});

test("R2Storage.get returns null for a missing key instead of throwing", async () => {
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    createFakeS3Client()
  );

  const result = await storage.get("does/not/exist.pdf");
  assert.equal(result, null);
});

test("R2Storage.getStream round-trips bytes through a real Readable, not a buffer", async () => {
  const fake = createFakeS3Client();
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    fake
  );

  const data = Buffer.from("%PDF-1.4\nstreamed content\n");
  await storage.put("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf", data, { contentType: "application/pdf" });

  const stream = await storage.getStream("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf");
  assert.ok(stream);
  assert.ok(stream instanceof Readable);
  assert.equal(await text(stream!), data.toString());
});

test("R2Storage.getStream returns null for a missing key instead of throwing", async () => {
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    createFakeS3Client()
  );

  const result = await storage.getStream("does/not/exist.pdf");
  assert.equal(result, null);
});

test("R2Storage.exists reflects whether the object is present", async () => {
  const fake = createFakeS3Client();
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    fake
  );

  assert.equal(await storage.exists("a.pdf"), false);
  await storage.put("a.pdf", Buffer.from("%PDF-1.4\n"));
  assert.equal(await storage.exists("a.pdf"), true);
});

test("R2Storage.delete removes the object", async () => {
  const fake = createFakeS3Client();
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    fake
  );

  await storage.put("a.pdf", Buffer.from("%PDF-1.4\n"));
  assert.equal(await storage.exists("a.pdf"), true);

  await storage.delete("a.pdf");
  assert.equal(await storage.exists("a.pdf"), false);
});

test("R2Storage.locate returns a non-public locator, not a browsable URL", () => {
  const storage = new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    createFakeS3Client()
  );
  assert.equal(storage.locate("a.pdf"), "r2://test-bucket/a.pdf");
});

function storageWith(client: Pick<ReturnType<typeof createFakeS3Client>, "send">) {
  return new R2Storage(
    { accountId: "acct", accessKeyId: "key", secretAccessKey: "secret", bucketName: "test-bucket" },
    client
  );
}

const SERVING = pdfServingHeaders("SISC Level 1 Mathematics 2019 — Paper 1");

test("R2Storage.put stores the serving headers it's given", async () => {
  const fake = createFakeS3Client();
  const storage = storageWith(fake);

  await storage.put("a.pdf", Buffer.from("%PDF-1.4\n"), SERVING);

  const info = await storage.describe("a.pdf");
  assert.equal(info?.contentType, "application/pdf");
  assert.equal(info?.contentDisposition, SERVING.contentDisposition);
  assert.equal(info?.cacheControl, "private, max-age=600");
});

test("R2Storage.setServingHeaders sets all three headers explicitly, keeping the bytes", async () => {
  const fake = createFakeS3Client();
  const storage = storageWith(fake);
  const key = "archive/sisc-l1/2019/mathematics/question-paper/sisc-l1_2019_mathematics_question-paper_1.pdf";
  const body = Buffer.from("%PDF-1.4\n%original bytes\n");
  // Start from a wrong Content-Type and no other headers, as on an object
  // stored before serving headers existed.
  await storage.put(key, body, { contentType: "binary/octet-stream" });
  const etagBefore = (await storage.describe(key))!.etag;

  const after = await storage.setServingHeaders(key, SERVING);

  assert.equal(after.contentType, "application/pdf", "Content-Type is set explicitly, not copied from the old object");
  assert.equal(after.contentDisposition, SERVING.contentDisposition);
  assert.equal(after.cacheControl, "private, max-age=600");
  assert.equal(after.etag, etagBefore, "the bytes must be unchanged");
  assert.equal((await storage.get(key))!.toString(), body.toString());
});

test("R2Storage.setServingHeaders only copies if the file is unchanged since it was looked at", async () => {
  const fake = createFakeS3Client();
  const sent: CopyObjectCommand[] = [];
  const storage = storageWith({
    ...fake,
    send: async (command: unknown) => {
      if (command instanceof CopyObjectCommand) sent.push(command);
      return fake.send(command);
    },
  });
  await storage.put("a.pdf", Buffer.from("%PDF-1.4\n"), { contentType: "application/pdf" });
  const { etag } = (await storage.describe("a.pdf"))!;

  await storage.setServingHeaders("a.pdf", SERVING);

  assert.equal(sent[0].input.MetadataDirective, "REPLACE");
  assert.equal(sent[0].input.CopySourceIfMatch, etag);
  assert.equal(sent[0].input.CopySource, "test-bucket/a.pdf");
  assert.equal(sent[0].input.ContentType, "application/pdf");
  assert.equal(sent[0].input.CacheControl, "private, max-age=600");
});

test("R2Storage.describe returns null for a missing key", async () => {
  assert.equal(await storageWith(createFakeS3Client()).describe("nope.pdf"), null);
});

test("R2Storage.presignedGetUrl refuses to run without a real R2 connection", async () => {
  await assert.rejects(storageWith(createFakeS3Client()).presignedGetUrl("a.pdf", 60), /real R2 connection/);
});

test("R2Storage.copy keeps the original and its headers, and never overwrites the destination", async () => {
  const fake = createFakeS3Client();
  const storage = storageWith(fake);
  await storage.put("archive/a.pdf", Buffer.from("%PDF-1.4\n%a\n"), SERVING);
  await storage.put("archive/taken.pdf", Buffer.from("%PDF-1.4\n%taken\n"));

  await assert.rejects(storage.copy("archive/a.pdf", "archive/taken.pdf"), StorageKeyExistsError);
  assert.equal((await storage.get("archive/taken.pdf"))!.toString(), "%PDF-1.4\n%taken\n");

  await storage.copy("archive/a.pdf", "quarantine/20261001T000000/archive/a.pdf");
  assert.equal(await storage.exists("archive/a.pdf"), true, "the original stays");
  const moved = await storage.describe("quarantine/20261001T000000/archive/a.pdf");
  assert.equal(moved?.contentDisposition, SERVING.contentDisposition, "stored headers travel with the file");
  assert.equal((await storage.get("quarantine/20261001T000000/archive/a.pdf"))!.toString(), "%PDF-1.4\n%a\n");
});
