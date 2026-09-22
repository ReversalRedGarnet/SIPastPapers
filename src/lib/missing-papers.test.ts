/**
 * Tests deriveMissingPaperRows: the filter that turns the coverage matrix
 * into the public /missing page's list. This is a plain function over
 * plain data (no database involved), so the input here is a small,
 * hand-built CoverageCell[] fixture rather than anything read from the
 * real archive -- see missing-papers.ts's own comment for why the
 * relevance filtering exists at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMissingPaperRows } from "./missing-papers";
import type { CoverageCell } from "./db/queries";

function cell(partial: Partial<CoverageCell> & Pick<CoverageCell, "examSeriesCode" | "year" | "subjectSlug" | "byType">): CoverageCell {
  return {
    examSeriesName: partial.examSeriesCode,
    subjectName: partial.subjectSlug,
    status: "missing",
    ...partial,
  };
}

test("a not_yet_recovered cell shows up in the derived rows", () => {
  const cells: CoverageCell[] = [
    // Establishes that sisc-l1/home-economics genuinely tracks marking_scheme
    // (a real published year), so the gap year below counts as relevant.
    cell({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "home-economics",
      byType: [{ type: "marking_scheme", status: "published" }],
    }),
    cell({
      examSeriesCode: "sisc-l1",
      year: 2021,
      subjectSlug: "home-economics",
      byType: [{ type: "marking_scheme", status: "not_yet_recovered" }],
    }),
  ];

  const rows = deriveMissingPaperRows(cells);
  const row = rows.find((r) => r.examSeriesCode === "sisc-l1" && r.year === 2021 && r.subjectSlug === "home-economics");
  assert.ok(row, "the not_yet_recovered 2021 cell should appear in the derived rows");
  assert.deepEqual(row!.missingTypes, ["Marking scheme"]);

  // The 2020 cell is fully published -- it must not appear at all.
  assert.ok(!rows.some((r) => r.year === 2020), "a fully-published cell should not be listed as missing");
});

test("a genuinely missing type (never ingested for that series/subject at all) still shows up", () => {
  const cells: CoverageCell[] = [
    cell({
      examSeriesCode: "sisc-l2-sinf6",
      year: 2016,
      subjectSlug: "chemistry",
      byType: [{ type: "question_paper", status: "published" }],
    }),
    cell({
      examSeriesCode: "sisc-l2-sinf6",
      year: 2015,
      subjectSlug: "chemistry",
      byType: [{ type: "question_paper", status: "missing" }],
    }),
  ];

  const rows = deriveMissingPaperRows(cells);
  const row = rows.find((r) => r.year === 2015 && r.subjectSlug === "chemistry");
  assert.ok(row, "a genuinely missing type should still be listed, not just not_yet_recovered ones");
  assert.deepEqual(row!.missingTypes, ["Question paper"]);
});

test("a subject never offered by a series is excluded, even though byType lists it as missing", () => {
  const cells: CoverageCell[] = [
    // Accounting is a real subject for sisc-l2-sinf6...
    cell({
      examSeriesCode: "sisc-l2-sinf6",
      year: 2020,
      subjectSlug: "accounting",
      byType: [{ type: "question_paper", status: "published" }],
    }),
    // ...but sif3-sijsc has never tracked it at all -- every cell for it
    // is 'missing' with nothing ever published/not_yet_recovered anywhere.
    // getCoverageMatrix() would still list "question_paper" here (since
    // typesBySubject is computed per-subject across ALL series), but it
    // isn't a real gap: the exam just never offered this subject.
    cell({
      examSeriesCode: "sif3-sijsc",
      year: 2020,
      subjectSlug: "accounting",
      byType: [{ type: "question_paper", status: "missing" }],
    }),
  ];

  const rows = deriveMissingPaperRows(cells);
  assert.ok(
    !rows.some((r) => r.examSeriesCode === "sif3-sijsc" && r.subjectSlug === "accounting"),
    "a subject the series has never once tracked should not be listed as a gap"
  );
  assert.ok(
    rows.some((r) => r.examSeriesCode === "sisc-l2-sinf6" && r.subjectSlug === "accounting" && r.year === 2020) === false,
    "the sisc-l2-sinf6 cell used here is fully published, so it shouldn't appear either"
  );
});

test("a type never offered by a series is excluded even when the subject itself is real for that series", () => {
  const cells: CoverageCell[] = [
    // English question papers are real for sisc-l1...
    cell({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "english",
      byType: [
        { type: "question_paper", status: "published" },
        // ...but listening_comprehension is only ever tracked for
        // sif3-sijsc -- never published, pending, or not_yet_recovered
        // for sisc-l1, anywhere. byType still lists it (since it's
        // computed per subject globally), so without the extra
        // per-type check this would wrongly show up as a gap.
        { type: "listening_comprehension", status: "missing" },
      ],
    }),
    cell({
      examSeriesCode: "sif3-sijsc",
      year: 2020,
      subjectSlug: "english",
      byType: [{ type: "listening_comprehension", status: "published" }],
    }),
  ];

  const rows = deriveMissingPaperRows(cells);
  const sisc1Row = rows.find((r) => r.examSeriesCode === "sisc-l1" && r.subjectSlug === "english");
  assert.ok(!sisc1Row, "listening_comprehension isn't a real sisc-l1 gap, so the whole cell has nothing genuinely missing");
});

test("returns an empty list when there are no gaps at all", () => {
  const cells: CoverageCell[] = [
    cell({
      examSeriesCode: "sisc-l1",
      year: 2020,
      subjectSlug: "mathematics",
      byType: [{ type: "question_paper", status: "published" }],
    }),
  ];
  assert.deepEqual(deriveMissingPaperRows(cells), []);
});
