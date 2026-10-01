/**
 * Tests R2Storage using a hand-written fake stand-in for the cloud storage
 * connection (just enough of it to handle save/read/check/delete
 * commands, backed by an in-memory list). No real cloud account,
 * credentials, or network access is needed to run these tests. See the
 * `client` parameter in src/lib/storage/r2.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { R2Storage } from "./r2";
import { StorageKeyExistsError } from "./types";

function notFoundError(name: string, httpStatusCode = 404) {
  const err = new Error(`${name} error`);
  (err as { name?: string }).name = name;
  (err as { $metadata?: { httpStatusCode: number } }).$metadata = { httpStatusCode };
  return err;
}

/** A stand-in for the real cloud storage connection — just an in-memory list of saved files. */
function createFakeS3Client() {
  const objects = new Map<string, { body: Buffer; contentType?: string }>();

  const client = {
    objects,
    send: async (command: unknown) => {
      if (command instanceof PutObjectCommand) {
        const { Key, Body, ContentType, IfNoneMatch } = command.input;
        // Like real R2: "If-None-Match: *" makes the write fail with 412
        // when something is already stored at this key.
        if (IfNoneMatch === "*" && objects.has(Key!)) throw notFoundError("PreconditionFailed", 412);
        objects.set(Key!, { body: Buffer.from(Body as Buffer), contentType: ContentType });
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
        if (!objects.has(command.input.Key!)) throw notFoundError("NotFound");
        return {};
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
  const result = await storage.put("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf", data, "application/pdf");

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

  await storage.put(key, Buffer.from("%PDF-1.4\n%original\n"), "application/pdf");
  await assert.rejects(
    storage.put(key, Buffer.from("%PDF-1.4\n%replacement\n"), "application/pdf"),
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
  await storage.put("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf", data, "application/pdf");

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
