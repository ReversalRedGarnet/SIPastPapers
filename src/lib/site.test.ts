import { test } from "node:test";
import assert from "node:assert/strict";
import { pastPapersOnlyNote } from "./site";

test("the past-papers-only note names this year in Honiara", () => {
  assert.equal(
    pastPapersOnlyNote(new Date("2026-10-29T00:00:00Z")),
    "Past papers only. We do not have current-year (2026) papers, official booklets, or exam answers for upcoming exams."
  );
});

test("the year rolls over at midnight Honiara time (UTC+11), not UTC", () => {
  assert.match(pastPapersOnlyNote(new Date("2026-12-31T12:59:00Z")), /\(2026\)/);
  assert.match(pastPapersOnlyNote(new Date("2026-12-31T13:00:00Z")), /\(2027\)/);
});
