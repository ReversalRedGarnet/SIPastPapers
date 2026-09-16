import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { LocalFilesystemStorage } from "./local-fs";

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
  "LocalFilesystemStorage.getStream returns null for a missing key instead of throwing",
  withTempStorage(async (storage) => {
    const result = await storage.getStream("does/not/exist.pdf");
    assert.equal(result, null);
  })
);
