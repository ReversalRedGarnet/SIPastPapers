// "import" pulls in something another file made available with "export"
// (see below). "@/" is a shortcut this project set up to mean "start from
// the src/ folder," so this line reaches into src/types/domain.ts. The
// word "type" here means we're only importing a *type* (a description of
// what shape a piece of data has, not actual code) — see domain.ts.
import type { ArtifactStatus } from "@/types/domain";

// "export" makes this function usable from other files. The "(bytes: number)"
// part says this function expects one input, named `bytes`, which must be a
// number — TypeScript checks this automatically and warns you if you ever
// pass in something else, like text. The ": string" after the parentheses
// says what type of value this function hands back when it's done.
export function formatBytes(bytes: number): string {
  // The backtick-quoted text below is a "template literal" — a string that
  // can have live values dropped into it using ${...}. Here it builds
  // something like "512 B" by inserting the current value of `bytes`.
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Public-facing display labels for exam series, keyed by the stable
 * exam_series.code (never the internal name) — see PROJECT_SPEC.md scope
 * baseline. This is display-only: the underlying codes (sif3-sijsc,
 * sisc-l1, sisc-l2-sinf6) and their combined internal names (e.g.
 * "SIF3 / SIJSC") are unchanged in the database, filenames, ingest, and
 * CLI output. SIF3 and SIJSC already share one series row/code, as do
 * SISC Level 2 and SINF6, so each maps to a single public label here.
 */
// `Record<string, string>` is a TypeScript type meaning "an object where
// every key and every value is text" -- it's how we describe a lookup
// table (an object used purely to look values up by name) to the type
// checker.
const SERIES_DISPLAY_LABEL: Record<string, string> = {
  "sif3-sijsc": "Form 3 / Year 9",
  "sisc-l1": "Form 5 / Year 11",
  "sisc-l2-sinf6": "Form 6 / Year 12",
};

/** Falls back to the raw code for any series not in the map above. */
export function seriesDisplayLabel(seriesCode: string): string {
  // `??` is the "nullish coalescing" operator: it means "use the value on
  // the left, unless it's missing (null/undefined), in which case fall
  // back to the value on the right." Here: use the display label if one
  // exists for this code, otherwise just show the raw code.
  return SERIES_DISPLAY_LABEL[seriesCode] ?? seriesCode;
}

// `ArtifactStatus` (imported above) is a "union type" -- TypeScript's way
// of saying "this value must be exactly one of these specific options,
// nothing else," e.g. "published" or "draft" but never a typo like
// "publised". A `switch` statement then branches based on which one it is,
// as a tidier alternative to a long chain of if/else checks.
export function statusLabel(status: ArtifactStatus): string {
  switch (status) {
    case "published":
      return "Published";
    case "pending_review":
      return "Pending review";
    case "draft":
      return "Draft";
    case "rights_hold":
      return "Rights hold";
    case "withdrawn":
      return "Withdrawn";
    case "not_yet_recovered":
      return "Not yet recovered";
    default:
      return status;
  }
}

export function statusTone(status: ArtifactStatus): "good" | "warn" | "bad" | "neutral" {
  switch (status) {
    case "published":
      return "good";
    case "pending_review":
      return "warn";
    case "rights_hold":
      return "bad";
    case "withdrawn":
      return "bad";
    case "not_yet_recovered":
      return "neutral";
    default:
      return "neutral";
  }
}
