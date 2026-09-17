import type { ArtifactType } from "@/types/domain";

/**
 * Pure helpers for deriving canonical, deterministic names from artifact
 * metadata — never from an uploaded file's original name (spec section 5.2).
 */

// `Record<ArtifactType, string>` is a lookup-table type (see format.ts for
// the basic idea) -- this one specifically requires a key for every single
// possible ArtifactType value, so if a new artifact type is ever added to
// that list elsewhere, TypeScript will refuse to compile this file until
// someone adds a matching entry here too.
const ARTIFACT_TYPE_LABEL: Record<ArtifactType, string> = {
  question_paper: "Question paper",
  marking_scheme: "Marking scheme",
  examiner_report: "Examiner report",
  listening_comprehension: "Listening comprehension",
  practical_paper: "Practical/CAT paper",
  other: "Other",
};

const ARTIFACT_TYPE_SLUG: Record<ArtifactType, string> = {
  question_paper: "question-paper",
  marking_scheme: "marking-scheme",
  examiner_report: "examiner-report",
  listening_comprehension: "listening-comprehension",
  practical_paper: "practical-paper",
  other: "other",
};

// `??` ("nullish coalescing") again -- see format.ts's seriesDisplayLabel
// for the full explanation. Short version: use the left side unless it's
// missing, then fall back to the right side.
export function artifactTypeLabel(type: ArtifactType): string {
  return ARTIFACT_TYPE_LABEL[type] ?? type;
}

// `/_/g` is a "regular expression" (regex) -- a mini pattern-matching
// language for text. This one matches every underscore character (the `g`
// means "every match, not just the first"). `.replace(pattern, "-")` then
// swaps every match for a hyphen, turning "question_paper" into
// "question-paper".
export function artifactTypeSlug(type: ArtifactType): string {
  return ARTIFACT_TYPE_SLUG[type] ?? type.replace(/_/g, "-");
}

/**
 * Public-facing label for one artifact in a list row / breadcrumb: question
 * papers are shown as "Examination Booklet", with the paper number appended
 * when one is set (subjects with more than one question paper for a year),
 * omitted otherwise. Other artifact types keep their plain type label.
 */
// `string | null` is a "union type": this value is either real text, or
// specifically the value `null`, meaning "there is deliberately no value
// here." Writing it out like this forces every piece of code that uses
// `paperNo` to handle the "there isn't one" case, instead of assuming
// there's always a value and crashing when there isn't.
export function artifactListLabel(type: ArtifactType, paperNo: string | null): string {
  if (type === "question_paper") {
    // `condition ? valueIfTrue : valueIfFalse` is a "ternary" -- a compact
    // one-line if/else. Here: if there's a paper number, use the first
    // string; otherwise use the second.
    return paperNo ? `Examination Booklet ${paperNo}` : "Examination Booklet";
  }
  return artifactTypeLabel(type);
}

// `(type, slug) => [slug, type as ArtifactType]` is an "arrow function" --
// a shorter way to write a small, throwaway function, commonly passed
// into methods like `.map()` below. `Object.entries(obj)` turns a lookup
// object into a list of [key, value] pairs; `.map()` then transforms each
// pair (here, swapping the key and value around); `Object.fromEntries(...)`
// turns the transformed list back into a lookup object. The `[type, slug]`
// part is "array destructuring" -- pulling the two items out of each pair
// into their own named variables in one step, rather than writing
// `pair[0]` and `pair[1]`. `as ArtifactType` is a "type assertion": it
// tells TypeScript "trust me, this string really is one of the known
// ArtifactType values," since TypeScript can't work that out on its own
// here.
const SLUG_TO_ARTIFACT_TYPE: Record<string, ArtifactType> = Object.fromEntries(
  Object.entries(ARTIFACT_TYPE_SLUG).map(([type, slug]) => [slug, type as ArtifactType])
);

/** Inverse of {@link artifactTypeSlug} — used to parse batch-ingest filenames. */
export function artifactTypeFromSlug(slug: string): ArtifactType | undefined {
  return SLUG_TO_ARTIFACT_TYPE[slug.toLowerCase()];
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "na";
}

/**
 * Known practical_paper paper_no values (see reorganize-papers.cjs's
 * Industrial Arts CAT/drawing-sheet handling) get a clean, specific title
 * suffix instead of the generic "Paper <paperNo> <type label>" pattern --
 * "Paper cat Practical/CAT paper" reads as a double-labeled duplicate of
 * the type itself, not a useful distinguishing suffix.
 */
const PRACTICAL_PAPER_SUFFIXES: Record<string, string> = {
  cat: "CAT Paper",
  drawingsheet: "Drawing Sheet",
};

/**
 * Design Technology's two parallel, mutually exclusive full papers (see
 * reorganize-papers.cjs's wood/food stream detection) get a clean,
 * stream-specific suffix instead of the generic "Paper <paperNo>" pattern.
 * Keyed on artifactType + paperNo, not on subjectName, so it can't
 * accidentally affect Industrial Arts' cat/drawingsheet labels above --
 * those are always practical_paper, this is always question_paper, so the
 * two lookups never collide even though both are matched on bare paperNo
 * strings. Same reasoning as this file's series-scoping precedent: don't
 * let a paperNo string carry meaning outside the (type, value) pair it was
 * actually assigned under.
 */
const QUESTION_PAPER_STREAM_SUFFIXES: Record<string, string> = {
  woodmetal: "Design Technology (Wood/Metal)",
  foodclothing: "Design Technology (Food/Clothing)",
};

/**
 * Title generated consistently from canonical metadata (spec section 6.3):
 * "<Exam series> <Subject> <Year> — <Paper N|Artifact type label>"
 */
export function generateArtifactTitle(params: {
  examSeriesName: string;
  subjectName: string;
  year: number;
  artifactType: ArtifactType;
  paperNo: string | null;
}): string {
  // "Destructuring": instead of writing `params.examSeriesName`,
  // `params.subjectName`, etc. separately, this one line pulls all five
  // named fields out of `params` and creates a separate variable for each,
  // matched up by name.
  const { examSeriesName, subjectName, year, artifactType, paperNo } = params;
  let suffix: string;
  if (artifactType === "practical_paper" && paperNo && PRACTICAL_PAPER_SUFFIXES[paperNo]) {
    suffix = PRACTICAL_PAPER_SUFFIXES[paperNo];
  } else if (artifactType === "question_paper" && paperNo && QUESTION_PAPER_STREAM_SUFFIXES[paperNo]) {
    suffix = QUESTION_PAPER_STREAM_SUFFIXES[paperNo];
  } else if (!paperNo) {
    suffix = artifactTypeLabel(artifactType);
  } else if (artifactType === "question_paper") {
    suffix = `Paper ${paperNo}`;
  } else {
    suffix = `Paper ${paperNo} ${artifactTypeLabel(artifactType)}`;
  }
  return `${examSeriesName} ${subjectName} ${year} — ${suffix}`;
}

/**
 * Deterministic file name per spec section 13.4:
 * <exam-series>_<year>_<subject>_<artifact-type>_<paper-no>.pdf
 */
export function generateCanonicalFileName(params: {
  examSeriesSlug: string;
  year: number;
  subjectSlug: string;
  artifactType: ArtifactType;
  paperNo: string | null;
}): string {
  const { examSeriesSlug, year, subjectSlug, artifactType, paperNo } = params;
  const paperSlug = paperNo ? slugify(paperNo) : "na";
  return `${examSeriesSlug}_${year}_${subjectSlug}_${artifactTypeSlug(artifactType)}_${paperSlug}.pdf`;
}

/**
 * Strips/replaces characters that are invalid in filenames on
 * Windows/macOS/Linux, and swaps an em dash for a plain hyphen since it
 * renders inconsistently across file pickers and older filesystems. Shared
 * by every place a human-readable name (not a slug) needs to become a safe
 * filename -- a single artifact download, or the outer name of a
 * multi-artifact zip.
 */
// This chains four method calls one after another (each one's result
// feeds into the next), which is a common pattern for "take this text and
// apply several cleanup steps in a row" -- easier to read top-to-bottom
// than nesting them inside one another.
export function sanitizeForFilename(text: string): string {
  return text
    .replace(/—/g, "-")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Human-readable download filename derived from an artifact's title (the
 * same string {@link generateArtifactTitle} produces and stores on the
 * artifact at ingest time) -- unlike {@link generateCanonicalFileName}'s
 * slug, this is what a person actually sees land in their Downloads
 * folder, so it keeps the readable title text.
 */
export function generateDownloadFilename(title: string): string {
  return `${sanitizeForFilename(title)}.pdf`;
}

/**
 * URL-facing slug for an artifact within its (series, year, subject) scope,
 * matching the pattern in spec section 12.1: "paper-1", "paper-1-marking-scheme".
 * There is no `slug` column in the schema (section 4.2) — it is always
 * computed from `type` + `paper_no` so it never drifts from the canonical
 * metadata.
 */
export function artifactSlug(params: {
  artifactType: ArtifactType;
  paperNo: string | null;
}): string {
  const { artifactType, paperNo } = params;
  const base = paperNo ? `paper-${slugify(paperNo)}` : artifactTypeSlug(artifactType);
  if (artifactType === "question_paper" || !paperNo) {
    return base;
  }
  return `${base}-${artifactTypeSlug(artifactType)}`;
}
