/**
 * Tests seriesDisplayLabel: the one shared place that turns an exam
 * series' internal code into a friendly public-facing name. This is a
 * plain function with no database involved, so no special test setup is
 * needed here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { seriesDisplayLabel } from "./format";

test("seriesDisplayLabel maps each known series code to its public label", () => {
  // These are the three actual exam series codes set up in
  // src/lib/db/seed.ts. SIF3 and SIJSC already share one combined code
  // ("sif3-sijsc"), as do SISC Level 2 and SINF6 ("sisc-l2-sinf6") — so
  // them mapping to the same label isn't a coincidence to keep in sync,
  // it's simply because they're the same entry to begin with.
  assert.equal(seriesDisplayLabel("sif3-sijsc"), "Form 3 / Year 9");
  assert.equal(seriesDisplayLabel("sisc-l1"), "Form 5 / Year 11");
  assert.equal(seriesDisplayLabel("sisc-l2-sinf6"), "Form 6 / Year 12");
});

test("seriesDisplayLabel falls back to the raw code for an unknown series", () => {
  assert.equal(seriesDisplayLabel("some-future-series"), "some-future-series");
});
