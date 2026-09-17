import type { ArtifactType } from "@/types/domain";

/**
 * Plain helper functions for generating consistent names — for titles,
 * file names, and URL paths — always built from an exam paper's own
 * details (exam series, subject, year, etc.), never from whatever name
 * the original uploaded file happened to have.
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
 * The label shown for one exam paper in a list or breadcrumb. Question
 * papers are shown as "Examination Booklet", with the paper number added
 * on the end if there's more than one for that subject and year (e.g.
 * "Examination Booklet 2"). Every other type of paper just uses its own
 * plain type label (e.g. "Marking scheme").
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

/** The reverse of {@link artifactTypeSlug} — turns a slug back into its artifact type. Used when reading batch-ingest file names. */
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
 * Certain known paper-number values for practical papers (Industrial
 * Arts' CAT and drawing-sheet papers) get a clean, specific title ending
 * instead of the usual generic "Paper <number> <type label>" pattern —
 * otherwise it would read as an odd, repetitive double-labeling like
 * "Paper cat Practical/CAT paper".
 */
const PRACTICAL_PAPER_SUFFIXES: Record<string, string> = {
  cat: "CAT Paper",
  drawingsheet: "Drawing Sheet",
};

/**
 * Design Technology has two separate full papers that a student takes one
 * or the other of (a "wood/metal" stream and a "food/clothing" stream).
 * These get their own clean, descriptive title ending instead of the
 * generic "Paper <number>" pattern.
 *
 * This lookup is keyed on the combination of artifact type + paper number
 * together, not just the subject name, so it can never accidentally clash
 * with the Industrial Arts suffixes above — those only ever apply to
 * practical papers, while this only ever applies to question papers, so
 * the same paper-number text used in each case can never be confused with
 * the other.
 */
const QUESTION_PAPER_STREAM_SUFFIXES: Record<string, string> = {
  woodmetal: "Design Technology (Wood/Metal)",
  foodclothing: "Design Technology (Food/Clothing)",
};

/**
 * Builds a paper's display title consistently, always in this format:
 * "<Exam series> <Subject> <Year> — <Paper number, or the type label>"
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
 * Builds a predictable, always-the-same file name, in this format:
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
 * Removes or replaces characters that aren't allowed in file names on
 * Windows, macOS, or Linux, and swaps an em dash (—) for a plain hyphen,
 * since the em dash doesn't display consistently everywhere. Used
 * anywhere a human-readable name (as opposed to a URL slug) needs to
 * become a safe file name — whether for a single downloaded paper, or for
 * the name of a zip file containing several papers.
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
 * Builds the file name a person actually sees when they download a paper
 * — built from the paper's readable title (the same title
 * {@link generateArtifactTitle} produces). Unlike
 * {@link generateCanonicalFileName}'s internal storage name, this one
 * keeps the human-readable text, since it's what lands in someone's
 * Downloads folder.
 */
export function generateDownloadFilename(title: string): string {
  return `${sanitizeForFilename(title)}.pdf`;
}

/**
 * Builds the part of the web address that identifies one exam paper
 * within its series/year/subject (e.g. "paper-1", "paper-1-marking-scheme").
 * There's no separate "slug" column stored in the database — it's always
 * calculated fresh from the paper's type and paper number, so it can never
 * fall out of sync with the paper's actual details.
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
