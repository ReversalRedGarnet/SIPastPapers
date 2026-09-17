/**
 * Pure-ish, testable logic behind scripts/cli.ts, split out so it can be
 * unit tested without importing cli.ts itself (which calls main() at
 * module load time based on process.argv, and calls process.exit() on
 * user errors — neither is safe to trigger from a test). Nothing in this
 * file calls process.exit; process.exitCode decisions are left to the
 * caller (cli.ts).
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  approveRights,
  checkRightsGate,
  ingestArtifact,
  listArtifactsBySeriesYearRange,
  publishArtifact,
  type ArtifactSummary,
} from "@/lib/db/queries";
import { artifactTypeFromSlug, artifactTypeSlug } from "@/lib/artifact-naming";
import type { ArtifactType, RightsStatus } from "@/types/domain";

export const VALID_TYPES: ArtifactType[] = [
  "question_paper",
  "marking_scheme",
  "examiner_report",
  "listening_comprehension",
  "practical_paper",
  "other",
];

// --- PDF validity -----------------------------------------------------------

export function isLikelyPdf(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.subarray(0, 4).toString("ascii") === "%PDF";
}

// A two-shape union again (see src/lib/db/queries.ts's publishArtifact) --
// either `{ ok: true }` alone, or `{ ok: false, reason: ... }` with an
// explanation attached.
export function validatePdfReadable(filePath: string): { ok: true } | { ok: false; reason: string } {
  if (path.extname(filePath).toLowerCase() !== ".pdf") {
    return { ok: false, reason: "not a .pdf file" };
  }
  try {
    const buffer = readFileSync(filePath);
    if (!isLikelyPdf(buffer)) {
      return { ok: false, reason: "missing %PDF header" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `cannot read file (${err instanceof Error ? err.message : String(err)})` };
  }
}

export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

/** Throws a descriptive Error (never exits the process) if the file isn't a readable PDF. */
export function readPdfFileOrThrow(filePath: string): Buffer {
  const check = validatePdfReadable(filePath);
  if (!check.ok) {
    throw new Error(`${check.reason}: ${filePath}`);
  }
  return readFileSync(filePath);
}

// --- rights basis vocabulary (spec section 11.2) ----------------------------

/**
 * Fixed vocabulary for --basis. Not free text: this is a record of *how*
 * the rights decision was reached, and "teacher-verified" in particular is
 * the primary verification path in current use (personal network of
 * teachers/education officers/former students) — it is not an
 * institutional approval, see the --approved-by note in PROJECT_SPEC.md
 * section 11.2.
 */
export const BASIS_CHOICES = [
  "teacher-verified",
  "personal-collection",
  "institutional-submission",
  "other",
] as const;
export type BasisChoice = (typeof BASIS_CHOICES)[number];

export function isValidBasis(value: string): value is BasisChoice {
  return (BASIS_CHOICES as readonly string[]).includes(value);
}

// --- ingest ------------------------------------------------------------------

export interface IngestCommonFlags {
  series: string;
  year: number;
  subject: string;
  source: string | null;
  sourceUrl: string | null;
  attribution: string | null;
}

/**
 * Batch filename convention: <artifact-type-slug>_<paper-no>.pdf, with the
 * paper-no segment omitted when not applicable (e.g. examiner-report.pdf).
 */
export const BATCH_FILENAME_PATTERN = /^([a-z]+(?:-[a-z]+)*)(?:_([A-Za-z0-9]+))?\.pdf$/i;

export interface BatchFileClassification {
  filename: string;
  artifactType: ArtifactType | null;
  paperNo: string | null;
  status: string;
  ok: boolean;
}

export function classifyBatchFile(dirPath: string, entry: string): BatchFileClassification {
  const match = entry.match(BATCH_FILENAME_PATTERN);
  if (!match) {
    return {
      filename: entry,
      artifactType: null,
      paperNo: null,
      status: "UNPARSEABLE: doesn't match <artifact-type>_<paper-no>.pdf",
      ok: false,
    };
  }

  const artifactType = artifactTypeFromSlug(match[1]);
  if (!artifactType) {
    return {
      filename: entry,
      artifactType: null,
      paperNo: match[2] ?? null,
      status: `UNPARSEABLE: unknown artifact type "${match[1]}" (expected one of ${VALID_TYPES.map(artifactTypeSlug).join(", ")})`,
      ok: false,
    };
  }

  const paperNo = match[2] ?? null;
  const check = validatePdfReadable(path.join(dirPath, entry));
  if (!check.ok) {
    return { filename: entry, artifactType, paperNo, status: `INVALID: ${check.reason}`, ok: false };
  }

  return { filename: entry, artifactType, paperNo, status: "OK", ok: true };
}

export interface DryRunSummary {
  rows: BatchFileClassification[];
  okCount: number;
  flaggedCount: number;
}

/**
 * Computes what `ingest <directory> --dry-run` would do — parsed
 * series/year/subject (fixed, from the shared flags) and per-file inferred
 * type/paper-no, or why a file can't be parsed — without writing anything
 * to the database or storage. Printing is left to the caller.
 */
export function planDirectoryIngest(dirPath: string, entries: string[]): DryRunSummary {
  const rows = entries.map((entry) => classifyBatchFile(dirPath, entry));
  const okCount = rows.filter((r) => r.ok).length;
  return { rows, okCount, flaggedCount: rows.length - okCount };
}

export interface BatchIngestSummary {
  ingested: number;
  skipped: number;
  failed: number;
}

/**
 * Ingests every .pdf in a directory under one fixed series/year/subject
 * (spec section 11.1). A file that can't be parsed is skipped; a file that
 * parses but fails to ingest (invalid PDF, duplicate, etc.) is counted as
 * failed — either way, the loop always continues to the remaining files
 * rather than aborting the batch. Progress is logged via `onProgress` if
 * given (defaults to console logging for CLI use); process.exitCode is
 * never touched here — the caller decides what a nonzero failed count
 * should mean for the process exit code.
 */
export async function ingestDirectory(
  dirPath: string,
  common: IngestCommonFlags,
  onProgress: (line: string, level: "log" | "warn" | "error") => void = (line, level) => console[level](line)
): Promise<BatchIngestSummary> {
  const entries = readdirSync(dirPath).filter((name) => name.toLowerCase().endsWith(".pdf"));

  let ingested = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const classification = classifyBatchFile(dirPath, entry);
    if (!classification.artifactType) {
      onProgress(`Skipping ${entry}: ${classification.status}`, "warn");
      skipped++;
      continue;
    }
    if (!classification.ok) {
      onProgress(`Failed to ingest ${entry}: ${classification.status}`, "error");
      failed++;
      continue;
    }
    const { artifactType, paperNo } = classification;
    const filePath = path.join(dirPath, entry);

    try {
      // classifyBatchFile already confirmed this file has a valid %PDF
      // header, so a plain read (rather than a helper that could exit the
      // process on failure) keeps one bad file from aborting the batch.
      const buffer = readFileSync(filePath);
      const result = await ingestArtifact({
        examSeriesCode: common.series,
        year: common.year,
        subjectSlug: common.subject,
        artifactType,
        paperNo,
        file: { buffer, mime: "application/pdf" },
        sourceOrganization: common.source,
        sourceUrl: common.sourceUrl,
        attribution: common.attribution,
      });
      onProgress(
        `Ingested "${result.title}" (id ${result.artifactId}, sha256 ${shortHash(result.sha256)}...) <- ${entry}`,
        "log"
      );
      ingested++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress(`Failed to ingest ${entry}: ${message}`, "error");
      failed++;
    }
  }

  return { ingested, skipped, failed };
}

// --- bulk approve-rights / publish (--series + --year-range) ---------------

/**
 * Parses the `--year-range` flag, e.g. "2016-2023" (inclusive on both
 * ends). Shared by bulk approve-rights and bulk publish.
 */
export function parseYearRange(input: string): { from: number; to: number } {
  const match = input.match(/^(\d{4})-(\d{4})$/);
  if (!match) {
    throw new Error(`--year-range must look like <start>-<end>, e.g. 2016-2023 (got "${input}")`);
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  if (from > to) {
    throw new Error(`--year-range start (${from}) must be <= end (${to})`);
  }
  return { from, to };
}

export interface BulkFilter {
  series: string;
  yearFrom: number;
  yearTo: number;
}

// --- bulk approve-rights ----------------------------------------------------

export interface BulkApproveRightsPlan {
  toApprove: ArtifactSummary[];
  alreadyApproved: ArtifactSummary[];
}

/**
 * Finds every artifact matching (series, year range) and splits it into
 * "needs rights approval" vs "already approved" (basis, approved_by and
 * evidence_uri already set — the same gate publishArtifact checks). Read
 * -only: makes no changes, so it's safe to call for both the dry-run
 * preview and immediately before executing.
 */
export async function planBulkApproveRights(filter: BulkFilter): Promise<BulkApproveRightsPlan> {
  const candidates = await listArtifactsBySeriesYearRange(filter.series, filter.yearFrom, filter.yearTo);
  const toApprove: ArtifactSummary[] = [];
  const alreadyApproved: ArtifactSummary[] = [];
  for (const artifact of candidates) {
    const gate = await checkRightsGate(artifact.id);
    (gate.satisfied ? alreadyApproved : toApprove).push(artifact);
  }
  return { toApprove, alreadyApproved };
}

export interface BulkApproveRightsInput {
  basis: BasisChoice;
  approvedBy: string;
  evidenceUri: string;
  rightsStatus?: Extract<RightsStatus, "permission_granted" | "public_domain_or_expired">;
  expiryDate?: string | null;
  notes?: string | null;
}

export interface BulkApproveRightsSummary {
  approved: number;
  failed: number;
}

/**
 * Applies the same basis/approved-by/evidence-uri/notes to every artifact in
 * `artifacts` (the caller passes plan.toApprove after the --confirm gate —
 * this function itself has no confirmation logic). One artifact failing
 * (e.g. a race with another process) doesn't abort the rest of the batch.
 */
export async function executeBulkApproveRights(
  artifacts: ArtifactSummary[],
  input: BulkApproveRightsInput,
  onProgress: (line: string, level: "log" | "warn" | "error") => void = (line, level) => console[level](line)
): Promise<BulkApproveRightsSummary> {
  let approved = 0;
  let failed = 0;
  for (const artifact of artifacts) {
    try {
      const result = await approveRights(artifact.id, input);
      onProgress(`Approved rights for ${artifact.id} (${artifact.title}): ${result.rightsStatus}`, "log");
      approved++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress(`Failed to approve rights for ${artifact.id} (${artifact.title}): ${message}`, "error");
      failed++;
    }
  }
  return { approved, failed };
}

// --- bulk publish -------------------------------------------------------

export interface BulkPublishPlan {
  toPublish: ArtifactSummary[];
  alreadyPublished: ArtifactSummary[];
  notApproved: { artifact: ArtifactSummary; missing: string[] }[];
}

/**
 * Finds every artifact matching (series, year range) and splits it three
 * ways: already published (no-op), rights not yet approved (can't publish —
 * carries `missing` so the caller can explain why), and ready to publish.
 * Read-only, same rationale as planBulkApproveRights.
 */
export async function planBulkPublish(filter: BulkFilter): Promise<BulkPublishPlan> {
  const candidates = await listArtifactsBySeriesYearRange(filter.series, filter.yearFrom, filter.yearTo);
  const toPublish: ArtifactSummary[] = [];
  const alreadyPublished: ArtifactSummary[] = [];
  const notApproved: { artifact: ArtifactSummary; missing: string[] }[] = [];
  for (const artifact of candidates) {
    if (artifact.status === "published") {
      alreadyPublished.push(artifact);
      continue;
    }
    const gate = await checkRightsGate(artifact.id);
    if (gate.satisfied) {
      toPublish.push(artifact);
    } else {
      notApproved.push({ artifact, missing: gate.missing });
    }
  }
  return { toPublish, alreadyPublished, notApproved };
}

export interface BulkPublishSummary {
  published: number;
  failed: number;
}

/**
 * Publishes every artifact in `artifacts` (the caller passes
 * plan.toPublish after the --confirm gate). Re-checks the rights gate via
 * publishArtifact itself (same safeguard as the single-artifact `publish`
 * command), so a rights record changed between plan and execute is still
 * caught rather than silently published.
 */
export async function executeBulkPublish(
  artifacts: ArtifactSummary[],
  onProgress: (line: string, level: "log" | "warn" | "error") => void = (line, level) => console[level](line)
): Promise<BulkPublishSummary> {
  let published = 0;
  let failed = 0;
  for (const artifact of artifacts) {
    const result = await publishArtifact(artifact.id);
    if ("missing" in result) {
      onProgress(
        `Failed to publish ${artifact.id} (${artifact.title}): rights record missing ${result.missing.join(", ")}`,
        "error"
      );
      failed++;
    } else {
      onProgress(`Published "${result.title}" (${artifact.id})`, "log");
      published++;
    }
  }
  return { published, failed };
}
