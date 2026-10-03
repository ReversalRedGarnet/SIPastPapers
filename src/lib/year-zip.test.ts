/** The naming rules for prebuilt year zips -- pure, no database or storage. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { yearZipFilename, yearZipKey, yearZipPrefix, yearZipServingHeaders, type YearZipFile } from "./year-zip";

const A: YearZipFile = { fileId: "a1", sha256: "1".repeat(64), title: "SISC Level 1 Mathematics 2019 — Paper 1" };
const B: YearZipFile = { fileId: "b2", sha256: "2".repeat(64), title: "SISC Level 1 English 2019 — Paper 1" };

test("a zip's key depends on exactly which files are in it, not their order", () => {
  const key = yearZipKey("sisc-l1", 2019, [A, B]);
  assert.match(key, /^zips\/sisc-l1\/2019\/[0-9a-f]{32}\.zip$/);
  assert.ok(key.startsWith(yearZipPrefix("sisc-l1", 2019)));
  assert.equal(yearZipKey("sisc-l1", 2019, [B, A]), key, "order doesn't matter");

  assert.notEqual(yearZipKey("sisc-l1", 2019, [A]), key, "a paper withdrawn");
  assert.notEqual(yearZipKey("sisc-l1", 2019, [A, B, { ...B, fileId: "c3" }]), key, "a paper added");
  assert.notEqual(yearZipKey("sisc-l1", 2019, [A, { ...B, sha256: "3".repeat(64) }]), key, "a file replaced");
  assert.notEqual(yearZipKey("sisc-l1", 2019, [A, { ...B, title: "Renamed" }]), key, "a name inside the zip changed");
  assert.notEqual(yearZipKey("sisc-l1", 2020, [A, B]), yearZipKey("sisc-l1", 2019, [A, B]).replace("2019", "2020"));
});

test("a zip downloads as an attachment with a readable name, cached like a PDF", () => {
  assert.equal(yearZipFilename("sisc-l1", 2019), "Form 5 - Year 11 2019.zip"); // same name as the old live-built zip
  const headers = yearZipServingHeaders("sisc-l1", 2019);
  assert.equal(headers.contentType, "application/zip");
  assert.equal(
    headers.contentDisposition,
    `attachment; filename="Form 5 - Year 11 2019.zip"; filename*=UTF-8''Form%205%20-%20Year%2011%202019.zip`
  );
  assert.equal(headers.cacheControl, "private, max-age=600");
});
