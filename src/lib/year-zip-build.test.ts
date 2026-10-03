/**
 * Building and storing year zips, against a temporary local storage
 * folder -- no database (the file lists are made up here).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalFilesystemStorage } from "@/lib/storage/local-fs";
import { buildYearZipBuffer, syncYearZip, type YearZipStatus } from "./year-zip-build";
import { yearZipKey } from "./year-zip";
import type { DownloadableYearFile } from "@/lib/db/queries";

/** Reads a zip's central directory: each entry's name, compression method (0 = stored) and sizes. */
function zipEntries(zip: Buffer): { name: string; method: number; size: number; compressedSize: number }[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "has an end-of-central-directory record");
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(offset), 0x02014b50, "central directory entry");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({ name: zip.toString("utf8", offset + 46, offset + 46 + nameLength), method, size, compressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function withTempStorage(fn: (storage: LocalFilesystemStorage) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sipp-year-zip-test-"));
    try {
      await fn(new LocalFilesystemStorage(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const PAPER_1 = Buffer.from("%PDF-1.4\n%paper one\n");
const PAPER_2 = Buffer.from("%PDF-1.4\n%paper two, a bit longer\n");
const FILES: DownloadableYearFile[] = [
  { fileId: "f1", storageKey: "archive/p1.pdf", title: "SISC Level 1 English 2019 — Paper 1", sha256: "1".repeat(64) },
  { fileId: "f2", storageKey: "archive/p2.pdf", title: "SISC Level 1 Mathematics 2019 — Paper 1", sha256: "2".repeat(64) },
];

test(
  "a year zip stores every PDF as-is, under its readable name",
  withTempStorage(async (storage) => {
    await storage.put("archive/p1.pdf", PAPER_1);
    await storage.put("archive/p2.pdf", PAPER_2);
    const zip = await buildYearZipBuffer(storage, FILES);
    assert.deepEqual(zipEntries(zip), [
      { name: "SISC Level 1 English 2019 - Paper 1.pdf", method: 0, size: PAPER_1.length, compressedSize: PAPER_1.length },
      { name: "SISC Level 1 Mathematics 2019 - Paper 1.pdf", method: 0, size: PAPER_2.length, compressedSize: PAPER_2.length },
    ]);
    assert.ok(zip.includes(PAPER_1) && zip.includes(PAPER_2), "bytes stored uncompressed");
  })
);

test(
  "no zip is built if any of its files is missing from storage",
  withTempStorage(async (storage) => {
    await storage.put("archive/p1.pdf", PAPER_1);
    await assert.rejects(buildYearZipBuffer(storage, FILES), /archive\/p2\.pdf is missing from storage/);
  })
);

test(
  "syncing stores the zip at its key, then deletes the year's old zips -- and does nothing more when up to date",
  withTempStorage(async (storage) => {
    await storage.put("archive/p1.pdf", PAPER_1);
    await storage.put("archive/p2.pdf", PAPER_2);
    await storage.put("zips/sisc-l1/2019/old.zip", Buffer.from("old"));
    const key = yearZipKey("sisc-l1", 2019, FILES);
    const status: YearZipStatus = {
      seriesCode: "sisc-l1",
      year: 2019,
      files: FILES,
      key,
      built: false,
      staleKeys: ["zips/sisc-l1/2019/old.zip"],
    };

    const result = await syncYearZip(storage, status);
    assert.ok(result.bytes > PAPER_1.length + PAPER_2.length);
    assert.deepEqual(result.deleted, ["zips/sisc-l1/2019/old.zip"]);
    assert.deepEqual(await storage.list("zips/"), [key]);

    const again = await syncYearZip(storage, { ...status, built: true, staleKeys: [] });
    assert.deepEqual(again, { bytes: 0, deleted: [] });
  })
);

test(
  "a failed build leaves the year's existing zips in place",
  withTempStorage(async (storage) => {
    await storage.put("zips/sisc-l1/2019/old.zip", Buffer.from("old"));
    const status: YearZipStatus = {
      seriesCode: "sisc-l1",
      year: 2019,
      files: FILES, // neither file is stored
      key: yearZipKey("sisc-l1", 2019, FILES),
      built: false,
      staleKeys: ["zips/sisc-l1/2019/old.zip"],
    };
    await assert.rejects(syncYearZip(storage, status));
    assert.deepEqual(await storage.list("zips/"), ["zips/sisc-l1/2019/old.zip"]);
  })
);
