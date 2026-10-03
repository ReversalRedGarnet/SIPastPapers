/** Search box parsing -- pure, no database. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearchQuery } from "./search-query";

test("a year becomes a year filter, and short forms of subjects match the full name too", () => {
  assert.deepEqual(parseSearchQuery("2018 maths"), { years: [2018], seriesCodes: [], termGroups: [["maths", "mathematics"]] });
  assert.deepEqual(parseSearchQuery("Mathematics 2018"), { years: [2018], seriesCodes: [], termGroups: [["mathematics"]] });
});

test("exam levels are recognised however they're written", () => {
  for (const q of ["Year 11 English", "form 5 english", "SISC Level 1 English", "english, level-1", "sisc l1 english"]) {
    assert.deepEqual(parseSearchQuery(q), { years: [], seriesCodes: ["sisc-l1"], termGroups: [["english"]] }, q);
  }
  assert.deepEqual(parseSearchQuery("form 3 science").seriesCodes, ["sif3-sijsc"]);
  assert.deepEqual(parseSearchQuery("Year 12 physics 2020").seriesCodes, ["sisc-l2-sinf6"]);
  assert.deepEqual(parseSearchQuery("SINF6 chemistry").seriesCodes, ["sisc-l2-sinf6"]);
  assert.deepEqual(parseSearchQuery("sisc biology").seriesCodes, ["sisc-l1", "sisc-l2-sinf6"], "plain SISC: both levels");
});

test("'year 11' is an exam level, not a year or a stray number", () => {
  const parsed = parseSearchQuery("year 11 2019");
  assert.deepEqual(parsed, { years: [2019], seriesCodes: ["sisc-l1"], termGroups: [] });
});

test("'paper 2' must appear as such; lone numbers and filler words are ignored", () => {
  assert.deepEqual(parseSearchQuery("form 3 science paper 2"), {
    years: [],
    seriesCodes: ["sif3-sijsc"],
    termGroups: [["paper 2"], ["science"]],
  });
  assert.deepEqual(parseSearchQuery("past exam papers 2 for english pdf"), { years: [], seriesCodes: [], termGroups: [["english"]] });
});

test("marking-scheme short forms, and repeated words counted once", () => {
  assert.deepEqual(parseSearchQuery("maths ms").termGroups, [["maths", "mathematics"], ["ms", "marking scheme"]]);
  assert.deepEqual(parseSearchQuery("English english").termGroups, [["english"]]);
});

test("nothing useful typed: no filters at all", () => {
  assert.deepEqual(parseSearchQuery("   past papers  "), { years: [], seriesCodes: [], termGroups: [] });
  assert.deepEqual(parseSearchQuery("%_'; drop table--"), { years: [], seriesCodes: [], termGroups: [["drop"], ["table"]] });
});

test("several years: any of them", () => {
  assert.deepEqual(parseSearchQuery("biology 2016 2017").years, [2016, 2017]);
});
