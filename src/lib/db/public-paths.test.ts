/** judgePath is pure -- no database connection is made here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { judgePath, type PublicPagePaths } from "./public-paths";

const PATHS: PublicPagePaths = {
  seriesCodes: new Set(["sisc-l1", "sif3-sijsc"]),
  years: new Set([2015, 2016, 2025]),
  subjectSlugs: new Set(["mathematics", "english"]),
  paperPaths: new Set(["sisc-l1/2016/mathematics/paper-1", "sisc-l1/2016/mathematics/marking-scheme"]),
};

test("real browse and paper addresses exist", () => {
  for (const p of [
    "/browse",
    "/browse/sisc-l1",
    "/browse/sisc-l1/2016",
    "/browse/sisc-l1/2016/english", // a real combination with no papers yet still has a page
    "/exams/sisc-l1/2016/mathematics/paper-1",
    "/exams/sisc-l1/2016/mathematics/marking-scheme/",
  ]) {
    assert.equal(judgePath(PATHS, p), "exists", p);
  }
});

test("made-up browse and paper addresses are missing", () => {
  for (const p of [
    "/browse/nope",
    "/browse/sisc-l1/1900",
    "/browse/sisc-l1/2016.0",
    "/browse/sisc-l1/02016",
    "/browse/sisc-l1/2016/made-up-subject",
    "/exams/sisc-l1/2016/mathematics/made-up-paper",
    "/exams/sisc-l1/2016/mathematics/PAPER-1",
    "/exams/nope/1900/x/y",
    "/exams/sisc-l1/2016/mathematics/%E0%A4%A", // broken %-encoding
  ]) {
    assert.equal(judgePath(PATHS, p), "missing", p);
  }
});

test("addresses that aren't browse or paper pages are left to Next.js", () => {
  for (const p of ["/", "/about", "/results", "/exams", "/exams/sisc-l1/2016", "/browse/sisc-l1/2016/mathematics/extra"]) {
    assert.equal(judgePath(PATHS, p), "unchecked", p);
  }
});

test("percent-encoded segments are compared decoded", () => {
  const paths = { ...PATHS, paperPaths: new Set(["sisc-l1/2016/mathematics/paper-a b"]) };
  assert.equal(judgePath(paths, "/exams/sisc-l1/2016/mathematics/paper-a%20b"), "exists");
});
