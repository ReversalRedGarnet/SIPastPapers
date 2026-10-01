/** quarantineKeyFor is pure -- no database connection is made here. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { quarantineKeyFor } from "./queries";

const KEY = "archive/sisc-l1/2019/mathematics/question-paper/sisc-l1_2019_mathematics_question-paper_1.pdf";

test("a quarantine key keeps the original key under a UTC timestamp", () => {
  assert.equal(
    quarantineKeyFor(KEY, new Date("2026-10-01T11:53:59.123Z")),
    `quarantine/20261001T115359/${KEY}`
  );
});

test("unpublishing again (after republishing from quarantine) gets a fresh key, not a nested one", () => {
  const first = quarantineKeyFor(KEY, new Date("2026-10-01T11:53:59Z"));
  assert.equal(quarantineKeyFor(first, new Date("2026-11-02T08:00:00Z")), `quarantine/20261102T080000/${KEY}`);
});
