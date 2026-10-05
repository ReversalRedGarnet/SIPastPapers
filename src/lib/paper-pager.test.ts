import { test } from "node:test";
import assert from "node:assert/strict";
import { adjacentOpenablePapers } from "./paper-pager";

const paper = (id: string, openable: boolean) => ({ id, openable });

test("Previous/Next are the papers right next to the current one when they can be opened", () => {
  const papers = [paper("a", true), paper("b", true), paper("c", true)];
  assert.deepEqual(adjacentOpenablePapers(papers, "b"), { prev: papers[0], next: papers[2] });
});

test("Previous/Next skip placeholders to the nearest paper that can be opened", () => {
  const papers = [paper("a", true), paper("x", false), paper("b", true), paper("y", false), paper("z", false), paper("c", true)];
  assert.deepEqual(adjacentOpenablePapers(papers, "b"), { prev: papers[0], next: papers[5] });
});

test("a placeholder's own page also links only to papers that can be opened", () => {
  const papers = [paper("a", true), paper("x", false), paper("y", false), paper("b", true)];
  assert.deepEqual(adjacentOpenablePapers(papers, "x"), { prev: papers[0], next: papers[3] });
});

test("no link on a side with only placeholders, or at either end", () => {
  const onlyPlaceholdersAround = [paper("x", false), paper("b", true), paper("y", false)];
  assert.deepEqual(adjacentOpenablePapers(onlyPlaceholdersAround, "b"), { prev: undefined, next: undefined });
  const ends = [paper("a", true), paper("b", true)];
  assert.deepEqual(adjacentOpenablePapers(ends, "a"), { prev: undefined, next: ends[1] });
  assert.deepEqual(adjacentOpenablePapers(ends, "b"), { prev: ends[0], next: undefined });
});

test("nothing at all when the current paper isn't in the list", () => {
  assert.deepEqual(adjacentOpenablePapers([paper("a", true)], "missing"), {});
});
