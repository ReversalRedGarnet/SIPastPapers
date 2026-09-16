import type {
  ArtifactStatus,
  RightsStatus,
  VerificationStatus,
} from "@/types/domain";

export function formatBytes(bytes: number): string {
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

export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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
const SERIES_DISPLAY_LABEL: Record<string, string> = {
  "sif3-sijsc": "Form 3 / Year 9",
  "sisc-l1": "Form 5 / Year 11",
  "sisc-l2-sinf6": "Form 6 / Year 12",
};

/** Falls back to the raw code for any series not in the map above. */
export function seriesDisplayLabel(seriesCode: string): string {
  return SERIES_DISPLAY_LABEL[seriesCode] ?? seriesCode;
}

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

export function verificationLabel(v: VerificationStatus): string {
  switch (v) {
    case "independently_verified":
      return "Independently verified";
    case "source_verified":
      return "Source verified";
    case "unverified":
      return "Unverified";
    case "flagged":
      return "Flagged for review";
    default:
      return v;
  }
}

export function verificationTone(v: VerificationStatus): "good" | "warn" | "bad" | "neutral" {
  switch (v) {
    case "independently_verified":
      return "good";
    case "source_verified":
      return "good";
    case "flagged":
      return "bad";
    case "unverified":
      return "neutral";
    default:
      return "neutral";
  }
}

export function rightsLabel(r: RightsStatus): string {
  switch (r) {
    case "permission_granted":
      return "Permission granted";
    case "public_domain_or_expired":
      return "Public domain / expired";
    case "pending":
      return "Rights pending";
    case "pending_institutional_approval":
      return "Pending institutional approval";
    case "rights_hold":
      return "Rights hold";
    case "denied":
      return "Rights denied";
    case "unknown":
      return "Rights unknown";
    default:
      return r;
  }
}

export function rightsTone(r: RightsStatus): "good" | "warn" | "bad" | "neutral" {
  switch (r) {
    case "permission_granted":
    case "public_domain_or_expired":
      return "good";
    case "pending":
    case "pending_institutional_approval":
      return "warn";
    case "rights_hold":
    case "denied":
      return "bad";
    default:
      return "neutral";
  }
}
