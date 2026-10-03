import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { LocalFilesystemStorage } from "./local-fs";
import { StorageKeyExistsError } from "./types";

function withTempStorage(fn: (storage: LocalFilesystemStorage) => Promise<void>) {
  const root = mkdtempSync(path.join(tmpdir(), "sipp-local-fs-test-"));
  return async () => {
    try {
      await fn(new LocalFilesystemStorage(root));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "LocalFilesystemStorage.getStream round-trips bytes through a real Readable",
  withTempStorage(async (storage) => {
    const data = Buffer.from("%PDF-1.4\nstreamed content\n");
    await storage.put("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf", data);

    const stream = await storage.getStream("archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf");
    assert.ok(stream);
    assert.ok(stream instanceof Readable);
    assert.equal(await text(stream!), data.toString());
  })
);

test(
  "LocalFilesystemStorage.put refuses to overwrite an existing file and leaves it untouched",
  withTempStorage(async (storage) => {
    const key = "archive/sisc-l1/2020/mathematics/question-paper/paper-1.pdf";
    await storage.put(key, Buffer.from("%PDF-1.4\n%original\n"));

    await assert.rejects(
      storage.put(key, Buffer.from("%PDF-1.4\n%replacement\n")),
      (err) => err instanceof StorageKeyExistsError && err.key === key
    );
    assert.equal((await storage.get(key))!.toString(), "%PDF-1.4\n%original\n");
  })
);

test(
  "LocalFilesystemStorage.getStream returns null for a missing key instead of throwing",
  withTempStorage(async (storage) => {
    const result = await storage.getStream("does/not/exist.pdf");
    assert.equal(result, null);
  })
);

test(
  "LocalFilesystemStorage.copy copies the bytes, keeps the original, and never overwrites the destination",
  withTempStorage(async (storage) => {
    await storage.put("archive/a.pdf", Buffer.from("%PDF-1.4\n%a\n"));
    await storage.put("archive/taken.pdf", Buffer.from("%PDF-1.4\n%taken\n"));

    await assert.rejects(storage.copy("archive/a.pdf", "archive/taken.pdf"), StorageKeyExistsError);
    assert.equal((await storage.get("archive/taken.pdf"))!.toString(), "%PDF-1.4\n%taken\n");

    await storage.copy("archive/a.pdf", "quarantine/20261001T000000/archive/a.pdf");
    assert.equal((await storage.get("archive/a.pdf"))!.toString(), "%PDF-1.4\n%a\n", "the original stays");
    assert.equal((await storage.get("quarantine/20261001T000000/archive/a.pdf"))!.toString(), "%PDF-1.4\n%a\n");
  })
);

test(
  "LocalFilesystemStorage.list returns every key under a prefix, and nothing for a missing folder",
  withTempStorage(async (storage) => {
    for (const key of ["zips/sisc-l1/2019/a.zip", "zips/sisc-l1/2019/b.zip", "zips/sisc-l1/2020/c.zip", "archive/x.pdf"]) {
      await storage.put(key, Buffer.from("x"));
    }
    assert.deepEqual((await storage.list("zips/sisc-l1/2019/")).sort(), ["zips/sisc-l1/2019/a.zip", "zips/sisc-l1/2019/b.zip"]);
    assert.deepEqual((await storage.list("zips/")).sort(), [
      "zips/sisc-l1/2019/a.zip",
      "zips/sisc-l1/2019/b.zip",
      "zips/sisc-l1/2020/c.zip",
    ]);
    assert.deepEqual(await storage.list("zips/nothing/"), []);
  })
);
