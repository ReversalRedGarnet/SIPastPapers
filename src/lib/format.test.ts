/**
 * Covers seriesDisplayLabel: the centralized public-facing display-label
 * mapping for exam series codes (PROJECT_SPEC.md scope baseline). No DB
 * access here — pure function, no isolation setup needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesDisplayLabel } from "./format";

test("seriesDisplayLabel maps each known series code to its public label", () => {
  // These are the three actual exam_series.code values seeded in
  // src/lib/db/seed.ts. SIF3 and SIJSC already share a single code/row
  // ("sif3-sijsc"), as do SISC Level 2 and SINF6 ("sisc-l2-sinf6") — so
  // "both map to the same label" falls straight out of them being the
  // same map key, with nothing separate to keep in sync.
  assert.equal(seriesDisplayLabel("sif3-sijsc"), "Form 3 / Year 9");
  assert.equal(seriesDisplayLabel("sisc-l1"), "Form 5 / Year 11");
  assert.equal(seriesDisplayLabel("sisc-l2-sinf6"), "Form 6 / Year 12");
});

test("seriesDisplayLabel falls back to the raw code for an unknown series", () => {
  assert.equal(seriesDisplayLabel("some-future-series"), "some-future-series");
});
