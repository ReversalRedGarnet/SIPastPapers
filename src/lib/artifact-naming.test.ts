import { test } from "node:test";
import assert from "node:assert/strict";
import { contentDispositionHeader } from "./artifact-naming";

test("contentDispositionHeader gives an ASCII filename plus the exact UTF-8 filename*", () => {
  assert.equal(
    contentDispositionHeader("inline", "SISC Level 1 Mathematics 2019 — Paper 1"),
    `inline; filename="SISC Level 1 Mathematics 2019 - Paper 1.pdf"; filename*=UTF-8''SISC%20Level%201%20Mathematics%202019%20-%20Paper%201.pdf`
  );
});

test("contentDispositionHeader slashes and quotes can't break the header", () => {
  const header = contentDispositionHeader("attachment", 'SISC Level 2 / SINF6 "Accounting" 2025');
  assert.match(header, /^attachment; filename="SISC Level 2 - SINF6 -Accounting- 2025\.pdf"; filename\*=UTF-8''/);
});

test("contentDispositionHeader replaces non-ASCII in the fallback but keeps it in filename*", () => {
  const header = contentDispositionHeader("inline", "Français (Paper 1)");
  assert.equal(
    header,
    `inline; filename="Fran_ais (Paper 1).pdf"; filename*=UTF-8''Fran%C3%A7ais%20%28Paper%201%29.pdf`
  );
});
