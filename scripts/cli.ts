/**
 * Local admin CLI (replaces the removed /admin/* web UI — see
 * PROJECT_SPEC.md section 11 and README.md). Run via `npm run cli -- <command>`.
 *
 * No authentication: this only ever runs locally, connecting straight to
 * the Postgres database (see DATABASE_URL_POOLED / src/lib/db/client.ts)
 * and whichever storage backend is configured (local filesystem by
 * default, or Cloudflare R2 — see src/lib/storage/index.ts and
 * STORAGE_BACKEND below), the same way a developer would run any other
 * local script.
 *
 * Argv parsing, --help text and process.exit() calls live here; the
 * underlying logic (batch classification, ingest, the --basis enum) lives
 * in scripts/cli-lib.ts, which has no process.exit calls and no argv
 * dependency, so it can be unit tested directly — see scripts/*.test.ts.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import {
  approveRights,
  getArtifactStatus,
  getCoverageMatrix,
  ingestArtifact,
  listAllArtifacts,
  listPublishedRightsExpiring,
  listPublishedWithUnapprovedRights,
  listStoredFiles,
  prepareArtifactPurge,
  publishArtifact,
  purgeArtifactFiles,
  unpublishArtifact,
  type CoverageCell,
  type CoverageStatus,
  type QuarantineResult,
  type StoredFile,
} from "@/lib/db/queries";
import { formatBytes } from "@/lib/format";
import { artifactTypeSlug, generateDownloadFilename } from "@/lib/artifact-naming";
import { pdfServingHeaders, type ServingHeaders } from "@/lib/storage/serving-headers";
import { getStorageProvider } from "@/lib/storage";
import { R2Storage, type StoredObjectInfo } from "@/lib/storage/r2";
import type { ArtifactStatus, ArtifactType, RightsStatus } from "@/types/domain";
import {
  BASIS_CHOICES,
  VALID_TYPES,
  executeBulkApproveRights,
  executeBulkPublish,
  ingestDirectory,
  isValidBasis,
  parseYearRange,
  planBulkApproveRights,
  planBulkPublish,
  planDirectoryIngest,
  readPdfFileOrThrow,
  shortHash,
  validatePdfReadable,
  type BasisChoice,
  type IngestCommonFlags,
} from "./cli-lib";

// Next.js loads .env.local automatically for `next dev`/`build`/`start`;
// this script runs standalone via `tsx`, outside that runtime, so it has
// to load it itself. Silently does nothing if the file doesn't exist —
// local storage needs no env vars at all, so a missing .env.local must
// not be an error. Must run before any command handler below calls
// getStorageProvider() (which reads STORAGE_BACKEND/R2_* lazily).
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// Opt into the patient (longer-timeout, multi-retry) Postgres connection
// budget — see src/lib/db/client.ts's getRetryBudget(). Unset, the pool
// defaults to the fast-fail "web" profile, which is right for a Next.js
// page load but too impatient for a batch CLI run riding out a slow Neon
// cold-start. Must run before any command handler makes its first query.
process.env.DB_POOL_PROFILE = "cli";

// --- tiny argv parser --------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value) throw new Error(`Missing required flag: --${name}`);
  return value;
}

// `never` is a special return type meaning "this function never actually
// finishes normally" -- it always either throws or, as here, ends the
// whole program (`process.exit(1)`). It's a signal to both readers and
// TypeScript that no code after calling `fail(...)` will ever run.
function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
  process.exit(1);
}

// --- ingest ---------------------------------------------------------------

function parseIngestCommonFlags(flags: Record<string, string>): IngestCommonFlags {
  const series = requireFlag(flags, "series");
  const year = Number(requireFlag(flags, "year"));
  if (!Number.isInteger(year)) fail("--year must be a whole number");
  const subject = requireFlag(flags, "subject");
  return {
    series,
    year,
    subject,
    source: flags.source ?? null,
    sourceUrl: flags["source-url"] ?? null,
    attribution: flags.attribution ?? null,
  };
}

async function ingestSingleFile(
  filePath: string,
  common: IngestCommonFlags,
  flags: Record<string, string>,
  dryRun: boolean
): Promise<void> {
  const artifactType = (flags.type ?? "question_paper") as ArtifactType;
  if (!VALID_TYPES.includes(artifactType)) {
    fail(`Unknown --type: ${artifactType} (expected one of ${VALID_TYPES.join(", ")})`);
  }
  const paperNo = flags["paper-no"] ?? null;

  if (dryRun) {
    const check = validatePdfReadable(filePath);
    const status = check.ok ? "OK" : `INVALID: ${check.reason}`;
    console.log(
      `${filePath}  series=${common.series} year=${common.year} subject=${common.subject} type=${artifactType} paper-no=${paperNo ?? "—"}  [${status}]`
    );
    console.log("\nDry run — no database or storage changes were made.");
    return;
  }

  let buffer: Buffer;
  try {
    buffer = readPdfFileOrThrow(filePath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

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

  console.log(
    `Ingested "${result.title}" (id ${result.artifactId}, sha256 ${shortHash(result.sha256)}...)`
  );
}

/**
 * Prints what `ingest <directory> --dry-run` would do. See
 * cli-lib.ts#planDirectoryIngest for the underlying (testable) logic.
 */
function printDirectoryDryRun(dirPath: string, common: IngestCommonFlags, entries: string[]): void {
  const { rows, okCount, flaggedCount } = planDirectoryIngest(dirPath, entries);

  const filenameWidth = Math.max(8, ...rows.map((r) => r.filename.length));
  const typeWidth = Math.max(4, ...rows.map((r) => (r.artifactType ? artifactTypeSlug(r.artifactType) : "—").length));
  const paperWidth = Math.max(8, ...rows.map((r) => (r.paperNo ?? "—").length));

  console.log(
    `Dry run: ${dirPath}  (series=${common.series}, year=${common.year}, subject=${common.subject})\n`
  );
  console.log(
    `${"Filename".padEnd(filenameWidth)}  ${"Type".padEnd(typeWidth)}  ${"Paper no".padEnd(paperWidth)}  Status`
  );
  console.log("-".repeat(filenameWidth + typeWidth + paperWidth + 20));

  for (const row of rows) {
    const typeDisplay = row.artifactType ? artifactTypeSlug(row.artifactType) : "—";
    console.log(
      `${row.filename.padEnd(filenameWidth)}  ${typeDisplay.padEnd(typeWidth)}  ${(row.paperNo ?? "—").padEnd(paperWidth)}  ${row.status}`
    );
  }

  console.log(
    `\nDry run complete: ${okCount} parseable, ${flaggedCount} flagged. No database or storage changes were made.`
  );
  if (flaggedCount > 0) process.exitCode = 1;
}

async function runIngest(args: ParsedArgs): Promise<void> {
  const target = args.positional[0];
  if (!target) fail("Usage: ingest <file-or-directory> --series <code> --year <yyyy> --subject <slug> [options]");

  const common = parseIngestCommonFlags(args.flags);
  const dryRun = Boolean(args.flags["dry-run"]);
  const stat = statSync(target, { throwIfNoEntry: false });
  if (!stat) fail(`Path not found: ${target}`);

  if (stat.isDirectory()) {
    if (args.flags.type || args.flags["paper-no"]) {
      fail("--type and --paper-no are not accepted for directory (batch) ingest — they are inferred per-file from each filename.");
    }
    const entries = readdirSync(target).filter((name) => name.toLowerCase().endsWith(".pdf"));
    if (entries.length === 0) {
      console.log(`No .pdf files found in ${target}`);
      return;
    }

    if (dryRun) {
      printDirectoryDryRun(target, common, entries);
      return;
    }

    const summary = await ingestDirectory(target, common);
    console.log(
      `\nBatch ingest complete: ${summary.ingested} ingested, ${summary.skipped} skipped, ${summary.failed} failed.`
    );
    if (summary.failed > 0) process.exitCode = 1;
  } else {
    await ingestSingleFile(target, common, args.flags, dryRun);
  }
}

// --- approve-rights ---------------------------------------------------------

const RIGHTS_STATUS_CHOICES: RightsStatus[] = ["permission_granted", "public_domain_or_expired"];

function formatArtifactRow(a: { id: string; year: number; subjectName: string; artifactType: string; paperNumber: string | null; title: string }): string {
  return `  ${a.id}  ${String(a.year)}  ${a.subjectName.padEnd(16)}  ${a.artifactType.padEnd(24)}  ${(a.paperNumber ?? "—").padEnd(4)}  ${a.title}`;
}

/**
 * Bulk mode for `approve-rights`: --series + --year-range instead of a
 * single <artifact-id>. Dry-run by default (prints exactly which artifacts
 * would be touched); only acts once --confirm is passed.
 */
async function runBulkApproveRights(series: string, yearRangeRaw: string, flags: Record<string, string>): Promise<void> {
  let range: { from: number; to: number };
  try {
    range = parseYearRange(yearRangeRaw);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const basisFlag = requireFlag(flags, "basis");
  if (!isValidBasis(basisFlag)) {
    fail(`--basis must be one of ${BASIS_CHOICES.join(", ")} (got "${basisFlag}")`);
  }
  const basis: BasisChoice = basisFlag;
  const approvedBy = requireFlag(flags, "approved-by");
  const evidenceUri = requireFlag(flags, "evidence-uri");
  const rightsStatusFlag = flags["rights-status"];
  if (rightsStatusFlag && !RIGHTS_STATUS_CHOICES.includes(rightsStatusFlag as RightsStatus)) {
    fail(`--rights-status must be one of ${RIGHTS_STATUS_CHOICES.join(", ")}`);
  }

  const plan = await planBulkApproveRights({ series, yearFrom: range.from, yearTo: range.to });

  console.log(`Bulk approve-rights: series=${series} years=${range.from}-${range.to}\n`);

  if (plan.alreadyApproved.length > 0) {
    console.log(`Already approved — skipped (${plan.alreadyApproved.length}):`);
    plan.alreadyApproved.forEach((a) => console.log(formatArtifactRow(a)));
    console.log();
  }

  if (plan.toApprove.length === 0) {
    console.log("No artifacts in this range need rights approval. Nothing to do.");
    return;
  }

  console.log(`Will approve rights (basis=${basis}, approved-by=${approvedBy}) for ${plan.toApprove.length} artifact(s):`);
  plan.toApprove.forEach((a) => console.log(formatArtifactRow(a)));

  if (!flags.confirm) {
    console.log(
      `\nDry run — no changes made. Re-run with --confirm to approve rights for the ${plan.toApprove.length} artifact(s) listed above.`
    );
    return;
  }

  console.log(`\n--confirm given — approving rights for ${plan.toApprove.length} artifact(s)...\n`);
  const summary = await executeBulkApproveRights(plan.toApprove, {
    basis,
    approvedBy,
    evidenceUri,
    rightsStatus: rightsStatusFlag as "permission_granted" | "public_domain_or_expired" | undefined,
    expiryDate: flags.expiry ?? null,
    notes: flags.notes ?? null,
  });
  console.log(`\nBulk approve-rights complete: ${summary.approved} approved, ${summary.failed} failed.`);
  if (summary.failed > 0) process.exitCode = 1;
}

async function runApproveRights(args: ParsedArgs): Promise<void> {
  const seriesFlag = args.flags.series;
  const yearRangeFlag = args.flags["year-range"];

  if (seriesFlag || yearRangeFlag) {
    if (!seriesFlag || !yearRangeFlag) {
      fail("Bulk approve-rights requires both --series and --year-range together (e.g. --series sif3-sijsc --year-range 2016-2023).");
    }
    if (args.positional[0]) {
      fail("Cannot combine a single <artifact-id> with --series/--year-range bulk mode.");
    }
    await runBulkApproveRights(seriesFlag, yearRangeFlag, args.flags);
    return;
  }

  const artifactId = args.positional[0];
  if (!artifactId) {
    fail(
      `Usage: approve-rights <artifact-id> --basis <${BASIS_CHOICES.join("|")}> --approved-by <name> --evidence-uri <uri> [options]\n` +
        `   or: approve-rights --series <code> --year-range <yyyy-yyyy> --basis <...> --approved-by <name> --evidence-uri <uri> [options] [--confirm]`
    );
  }

  const basisFlag = requireFlag(args.flags, "basis");
  if (!isValidBasis(basisFlag)) {
    fail(`--basis must be one of ${BASIS_CHOICES.join(", ")} (got "${basisFlag}")`);
  }
  const basis: BasisChoice = basisFlag;
  const approvedBy = requireFlag(args.flags, "approved-by");
  const evidenceUri = requireFlag(args.flags, "evidence-uri");
  const rightsStatusFlag = args.flags["rights-status"];
  if (rightsStatusFlag && !RIGHTS_STATUS_CHOICES.includes(rightsStatusFlag as RightsStatus)) {
    fail(`--rights-status must be one of ${RIGHTS_STATUS_CHOICES.join(", ")}`);
  }

  const result = await approveRights(artifactId, {
    basis,
    approvedBy,
    evidenceUri,
    rightsStatus: rightsStatusFlag as "permission_granted" | "public_domain_or_expired" | undefined,
    expiryDate: args.flags.expiry ?? null,
    notes: args.flags.notes ?? null,
  });

  console.log(`Rights approved for ${artifactId}: ${result.rightsStatus}`);
}

// --- publish / unpublish ----------------------------------------------------

/**
 * Bulk mode for `publish`: --series + --year-range instead of a single
 * <artifact-id>. Dry-run by default; only acts once --confirm is passed.
 * Artifacts already published, or whose rights aren't approved yet, are
 * skipped with an explanation rather than attempted.
 */
async function runBulkPublish(series: string, yearRangeRaw: string, flags: Record<string, string>): Promise<void> {
  let range: { from: number; to: number };
  try {
    range = parseYearRange(yearRangeRaw);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const plan = await planBulkPublish({ series, yearFrom: range.from, yearTo: range.to });

  console.log(`Bulk publish: series=${series} years=${range.from}-${range.to}\n`);

  if (plan.alreadyPublished.length > 0) {
    console.log(`Already published — skipped (${plan.alreadyPublished.length}):`);
    plan.alreadyPublished.forEach((a) => console.log(formatArtifactRow(a)));
    console.log();
  }

  if (plan.notApproved.length > 0) {
    console.log(`Rights not yet approved — skipped (${plan.notApproved.length}):`);
    plan.notApproved.forEach(({ artifact, missing }) =>
      console.log(`${formatArtifactRow(artifact)}  [missing: ${missing.join(", ")}]`)
    );
    console.log();
  }

  if (plan.toPublish.length === 0) {
    console.log("No artifacts in this range are ready to publish. Nothing to do.");
    return;
  }

  console.log(`Will publish ${plan.toPublish.length} artifact(s):`);
  plan.toPublish.forEach((a) => console.log(formatArtifactRow(a)));

  if (!flags.confirm) {
    console.log(
      `\nDry run — no changes made. Re-run with --confirm to publish the ${plan.toPublish.length} artifact(s) listed above.`
    );
    return;
  }

  console.log(`\n--confirm given — publishing ${plan.toPublish.length} artifact(s)...\n`);
  const summary = await executeBulkPublish(plan.toPublish);
  console.log(`\nBulk publish complete: ${summary.published} published, ${summary.failed} failed.`);
  if (summary.failed > 0) process.exitCode = 1;
}

async function runPublish(args: ParsedArgs): Promise<void> {
  const seriesFlag = args.flags.series;
  const yearRangeFlag = args.flags["year-range"];

  if (seriesFlag || yearRangeFlag) {
    if (!seriesFlag || !yearRangeFlag) {
      fail("Bulk publish requires both --series and --year-range together (e.g. --series sif3-sijsc --year-range 2016-2023).");
    }
    if (args.positional[0]) {
      fail("Cannot combine a single <artifact-id> with --series/--year-range bulk mode.");
    }
    await runBulkPublish(seriesFlag, yearRangeFlag, args.flags);
    return;
  }

  const artifactId = args.positional[0];
  if (!artifactId) {
    fail(
      "Usage: publish <artifact-id>\n   or: publish --series <code> --year-range <yyyy-yyyy> [--confirm]"
    );
  }

  const result = await publishArtifact(artifactId);
  if ("missing" in result) {
    console.error(`Cannot publish ${artifactId} — still needs:`);
    result.missing.forEach((m) => console.error(`  - ${m}`));
    console.error(
      `Rights details are filled in with "approve-rights ${artifactId} --basis ... --approved-by ... --evidence-uri ...".`
    );
    process.exitCode = 1;
    return;
  }
  if (result.filesRestored > 0) {
    console.log(`Moved ${result.filesRestored} stored file(s) back from quarantine to their original key.`);
  }
  console.log(`Published "${result.title}" (${artifactId}).`);
}

const UNPUBLISH_STATUS_CHOICES: ArtifactStatus[] = ["withdrawn", "rights_hold"];

function printQuarantineResult(result: QuarantineResult): void {
  if (result.filesMoved > 0) {
    console.log(
      `Moved ${result.filesMoved} stored file(s) to quarantine -- download links already handed out stop working now.`
    );
  }
  if (result.moveErrors.length > 0) {
    console.error(
      `WARNING: couldn't fully move ${result.moveErrors.length} stored file(s). The paper is unpublished and the site` +
        `\nno longer hands it out, but a link handed out in the last 10 minutes can keep working until it expires:`
    );
    result.moveErrors.forEach((e) => console.error(`  ${e}`));
    process.exitCode = 1;
  }
}

const UNPUBLISH_USAGE =
  "Usage: unpublish <artifact-id> [--status withdrawn|rights_hold] [--reason <text>] [--purge [--confirm]]";

async function runUnpublish(args: ParsedArgs): Promise<void> {
  const artifactId = args.positional[0];
  if (!artifactId) fail(UNPUBLISH_USAGE);
  const purge = args.flags.purge === "true";
  if (args.flags.confirm && !purge) fail(`--confirm only applies to --purge.\n${UNPUBLISH_USAGE}`);
  const reason = args.flags.reason ?? null;

  const status = (args.flags.status ?? "withdrawn") as ArtifactStatus;
  if (!UNPUBLISH_STATUS_CHOICES.includes(status)) {
    fail(`--status must be one of ${UNPUBLISH_STATUS_CHOICES.join(", ")}`);
  }

  // With --purge, a paper that's already unpublished just goes on to the
  // purge step; without it, unpublishing it again is an error.
  if (!purge || (await getArtifactStatus(artifactId)) === "published") {
    const result = await unpublishArtifact(artifactId, status as "withdrawn" | "rights_hold", reason);
    console.log(`Unpublished "${result.title}" (${artifactId}) -> ${status}.`);
    printQuarantineResult(result);
  }
  if (purge) await runPurge(artifactId, args.flags.confirm === "true", reason);
}

/**
 * `unpublish --purge`: makes sure every file of the (now unpublished) paper
 * is in quarantine, then lists what would be permanently deleted -- and,
 * only with --confirm, deletes it (audit-logged as file_purged).
 */
async function runPurge(artifactId: string, confirm: boolean, reason: string | null): Promise<void> {
  const plan = await prepareArtifactPurge(artifactId);
  printQuarantineResult(plan.quarantine);
  if (plan.quarantine.moveErrors.length > 0) {
    console.error("\nNot purging: fix the files above first (they're not all in quarantine).");
    return;
  }
  if (plan.files.length === 0) {
    console.log(`\n"${plan.title}" has no stored files in quarantine -- nothing to purge.`);
    return;
  }

  console.log(`\n${confirm ? "Permanently deleting" : "Would permanently delete"} ${plan.files.length} file(s):`);
  plan.files.forEach((f) => console.log(`  ${f.storageKey}  (${formatBytes(f.bytes)})`));
  if (!confirm) {
    console.log(
      `\nDry run -- nothing deleted (the file(s) stay in quarantine, recoverable by publishing again).` +
        `\nTo delete permanently: unpublish ${artifactId} --purge --confirm`
    );
    return;
  }

  const result = await purgeArtifactFiles(artifactId, reason);
  console.log(`\nPurged ${result.purged.length} file(s). Each is logged in audit_events as file_purged.`);
  if (result.errors.length > 0) {
    console.error(`WARNING: ${result.errors.length} file(s) not purged:`);
    result.errors.forEach((e) => console.error(`  ${e}`));
    process.exitCode = 1;
  }
}

// --- list -------------------------------------------------------------------

async function runList(): Promise<void> {
  const artifacts = await listAllArtifacts();
  if (artifacts.length === 0) {
    console.log("No artifacts in the database yet.");
    return;
  }
  for (const a of artifacts) {
    console.log(
      `${a.id}  ${String(a.year)}  ${a.subjectName.padEnd(16)}  ${a.artifactType.padEnd(15)}  ${(a.paperNumber ?? "—").padEnd(4)}  ${a.status.padEnd(18)}  ${a.rightsStatus.padEnd(28)}  ${a.hasFile ? "file" : "no file"}  ${a.title}`
    );
  }
}

// --- rights-expiring --------------------------------------------------------

async function runRightsExpiring(args: ParsedArgs): Promise<void> {
  const days = Number(args.flags.days);
  if (!args.flags.days || !Number.isInteger(days) || days < 0) {
    fail("Usage: rights-expiring --days <N>   (N = a whole number of days, 0 or more)");
  }

  const entries = await listPublishedRightsExpiring(days);
  const expired = entries.filter((e) => e.daysLeft < 0);
  const upcoming = entries.filter((e) => e.daysLeft >= 0);

  console.log(`Published papers whose rights expire within ${days} day${days === 1 ? "" : "s"} (${upcoming.length}):`);
  if (upcoming.length === 0) console.log("  (none)");
  for (const e of upcoming) {
    const when = e.daysLeft === 0 ? "today (last valid day)" : `in ${e.daysLeft} day${e.daysLeft === 1 ? "" : "s"}`;
    console.log(`  ${e.expiry}  ${when.padEnd(22)}  ${e.artifactId}  ${e.title}`);
  }

  console.log(`\nAlready expired -- published but now HIDDEN from the public site (${expired.length}):`);
  if (expired.length === 0) console.log("  (none)");
  for (const e of expired) {
    const ago = `${-e.daysLeft} day${e.daysLeft === -1 ? "" : "s"} ago`;
    console.log(`  ${e.expiry}  ${ago.padEnd(22)}  ${e.artifactId}  ${e.title}`);
  }

  const unapproved = await listPublishedWithUnapprovedRights();
  console.log(`\nRights no longer approved -- published but now HIDDEN from the public site (${unapproved.length}):`);
  if (unapproved.length === 0) console.log("  (none)");
  for (const u of unapproved) {
    console.log(`  ${(u.rightsStatus ?? "no rights record").padEnd(32)}  ${u.artifactId}  ${u.title}`);
  }

  if (expired.length > 0 || unapproved.length > 0) {
    console.log(
      "\nHidden papers stay hidden until their rights are approved again (approve-rights, with a new --expiry if" +
        "\nneeded), or can be taken down properly with unpublish."
    );
  }
}

// --- R2 object headers -------------------------------------------------------

// How long the presigned check link printed by inspect-object and
// set-disposition stays valid.
const PRESIGNED_CHECK_SECONDS = 300;

const SHOWN_RESPONSE_HEADERS = [
  "content-type",
  "content-disposition",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
  "cache-control",
];

function requireR2Storage(): R2Storage {
  const storage = getStorageProvider();
  if (!(storage instanceof R2Storage)) {
    fail("This command only works with STORAGE_BACKEND=r2 (plus the R2_* settings) in .env.local.");
  }
  return storage;
}

async function findStoredFile(flags: Record<string, string>): Promise<StoredFile> {
  const key = flags.key;
  const fileId = flags["file-id"];
  if (Boolean(key) === Boolean(fileId)) fail("Give exactly one of --key <storage-key> or --file-id <id>.");
  const match = (await listStoredFiles()).find((f) => (key ? f.storageKey === key : f.fileId === fileId));
  if (!match) fail(`No file record found for ${key ? `key "${key}"` : `file id ${fileId}`}.`);
  return match;
}

function printStoredInfo(label: string, info: StoredObjectInfo | null): void {
  console.log(`${label}:`);
  if (!info) {
    console.log("  (no object in R2 at this key)");
    return;
  }
  console.log(`  Content-Type:        ${info.contentType ?? "(none)"}`);
  console.log(`  Content-Disposition: ${info.contentDisposition ?? "(none)"}`);
  console.log(`  Cache-Control:       ${info.cacheControl ?? "(none)"}`);
  console.log(`  Content-Length:      ${info.contentLength ?? "?"}`);
  console.log(`  ETag:                ${info.etag ?? "?"}`);
  console.log(`  Last-Modified:       ${info.lastModified?.toISOString() ?? "?"}`);
}

/** Which of the three serving headers on a stored object differ from what they should be (empty = all correct). */
function headersToChange(info: StoredObjectInfo, target: ServingHeaders): string[] {
  const changes: string[] = [];
  if (info.contentType !== target.contentType) changes.push("Content-Type");
  if (info.contentDisposition !== target.contentDisposition) changes.push("Content-Disposition");
  if (info.cacheControl !== target.cacheControl) changes.push("Cache-Control");
  return changes;
}

/**
 * Fetches the file through a real presigned R2 link -- exactly what a
 * visitor's browser would be sent to -- and prints the headers R2 actually
 * answers with. Asks for just the first byte (a Range request), so this
 * check doesn't download the whole file.
 */
async function printPresignedResponse(storage: R2Storage, key: string): Promise<void> {
  const url = await storage.presignedGetUrl(key, PRESIGNED_CHECK_SECONDS);
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  console.log("\nResponse from a presigned R2 link (GET, Range: bytes=0-0):");
  console.log(`  HTTP ${response.status} ${response.statusText}`);
  for (const name of SHOWN_RESPONSE_HEADERS) {
    console.log(`  ${name}: ${response.headers.get(name) ?? "(not sent)"}`);
  }
  await response.body?.cancel();
  console.log(`\nPresigned link, valid for ${PRESIGNED_CHECK_SECONDS / 60} minutes (to try in a browser):\n  ${url}`);
}

async function runInspectObject(args: ParsedArgs): Promise<void> {
  const storage = requireR2Storage();
  const file = await findStoredFile(args.flags);
  console.log(`${file.title}\n  key: ${file.storageKey}\n  file id: ${file.fileId} (${file.status})\n`);
  printStoredInfo("Stored in R2", await storage.describe(file.storageKey));
  await printPresignedResponse(storage, file.storageKey);
}

async function runSetDispositionOne(storage: R2Storage, flags: Record<string, string>): Promise<void> {
  const file = await findStoredFile(flags);
  const target = pdfServingHeaders(file.title);
  console.log(`${file.title}\n  key: ${file.storageKey}\n  file id: ${file.fileId} (${file.status})\n`);

  const before = await storage.describe(file.storageKey);
  printStoredInfo("Before", before);
  if (!before) fail("Nothing to update.");
  if (headersToChange(before, target).length === 0) {
    console.log("\nAlready set -- no change made.");
  } else {
    printStoredInfo("\nAfter", await storage.setServingHeaders(file.storageKey, target));
  }
  await printPresignedResponse(storage, file.storageKey);
}

// How many of the objects that would change a dry run prints as examples.
const DRY_RUN_SAMPLE_SIZE = 5;

async function runSetDispositionAll(storage: R2Storage, confirm: boolean): Promise<void> {
  // Several file records can't share a key in practice, but de-duplicate
  // anyway so no object is rewritten twice.
  const files = [...new Map((await listStoredFiles()).map((f) => [f.storageKey, f])).values()];
  let alreadySet = 0;
  let missing = 0;
  let updated = 0;
  let failed = 0;
  const pending: { file: StoredFile; changes: string[] }[] = [];

  for (const file of files) {
    const info = await storage.describe(file.storageKey);
    if (!info) {
      missing++;
      console.log(`MISSING  ${file.storageKey}`);
      continue;
    }
    const changes = headersToChange(info, pdfServingHeaders(file.title));
    if (changes.length === 0) alreadySet++;
    else pending.push({ file, changes });
  }

  if (!confirm) {
    console.log(
      `${files.length} objects: ${pending.length} would be updated, ${alreadySet} already set, ${missing} missing from R2.`
    );
    if (pending.length > 0) {
      console.log(`\nSample of what would be set (first ${Math.min(DRY_RUN_SAMPLE_SIZE, pending.length)}):`);
      for (const { file, changes } of pending.slice(0, DRY_RUN_SAMPLE_SIZE)) {
        console.log(`  ${generateDownloadFilename(file.title)}`);
        console.log(`    key: ${file.storageKey}`);
        console.log(`    changes: ${changes.join(", ")}`);
      }
      const target = pdfServingHeaders("example");
      console.log(
        `\nEvery updated object gets Content-Type: ${target.contentType}, Cache-Control: ${target.cacheControl},` +
          `\nand Content-Disposition: inline with its own filename (ASCII filename + UTF-8 filename*).`
      );
    }
    console.log("\nDry run -- nothing changed. Re-run with --confirm to update.");
    return;
  }

  for (const { file } of pending) {
    try {
      await storage.setServingHeaders(file.storageKey, pdfServingHeaders(file.title));
      updated++;
      console.log(`UPDATED  ${file.storageKey}`);
    } catch (err) {
      failed++;
      console.error(`FAILED   ${file.storageKey}: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(
    `\n${files.length} objects: ${updated} updated, ${alreadySet} already set, ${missing} missing from R2, ${failed} failed.`
  );
  if (failed > 0) process.exitCode = 1;
}

async function runSetDisposition(args: ParsedArgs): Promise<void> {
  const storage = requireR2Storage();
  if (args.flags.all) {
    if (args.flags.key || args.flags["file-id"]) fail("--all can't be combined with --key or --file-id.");
    await runSetDispositionAll(storage, args.flags.confirm === "true");
  } else {
    await runSetDispositionOne(storage, args.flags);
  }
}

// --- coverage ---------------------------------------------------------------

const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  published: "Published",
  verified_pending_rights: "Rights pending",
  missing: "Missing",
  not_yet_recovered: "Not yet recovered",
};

// Short codes for a cell's per-type breakdown (e.g. "QP:Published, MS:Not
// yet recovered") -- kept short since a cell can list several of these
// side by side.
const ARTIFACT_TYPE_CODE: Record<ArtifactType, string> = {
  question_paper: "QP",
  marking_scheme: "MS",
  examiner_report: "ER",
  listening_comprehension: "LC",
  practical_paper: "PP",
  other: "OT",
};

// A subject that only ever tracks one artifact type (e.g. most subjects
// only ever get question papers ingested) renders as a single collapsed
// label, same as before this command was type-aware. A subject that tracks
// more than one type (question paper + marking scheme, or + examiner
// report/listening comprehension/practical paper) always shows the full
// per-type breakdown -- even when every type currently agrees -- so a
// cell's status can never quietly regress back to a single misleading
// label if one of its types changes later.
function renderCell(cell: CoverageCell): string {
  if (cell.byType.length <= 1) {
    return COVERAGE_LABEL[cell.status];
  }
  return cell.byType
    .map(({ type, status }) => `${ARTIFACT_TYPE_CODE[type]}:${COVERAGE_LABEL[status]}`)
    .join(", ");
}

async function runCoverage(): Promise<void> {
  const cells = await getCoverageMatrix();
  if (cells.length === 0) {
    console.log("No exam series/subjects in the database yet.");
    return;
  }

  const seriesList = [...new Set(cells.map((c) => c.examSeriesCode))].map((code) => {
    const cell = cells.find((c) => c.examSeriesCode === code)!;
    return { code, name: cell.examSeriesName };
  });
  const years = [...new Set(cells.map((c) => c.year))].sort((a, b) => a - b);
  const subjects = [...new Set(cells.map((c) => c.subjectSlug))].map((slug) => {
    const cell = cells.find((c) => c.subjectSlug === slug)!;
    return { slug, name: cell.subjectName };
  });

  const cellFor = (seriesCode: string, year: number, subjectSlug: string) =>
    cells.find((c) => c.examSeriesCode === seriesCode && c.year === year && c.subjectSlug === subjectSlug);

  for (const series of seriesList) {
    console.log(`\n${series.name}`);

    // Column width now depends on the actual rendered text (which can be a
    // multi-type breakdown, not just one of the four fixed labels), so it's
    // measured from every real cell in the column rather than from
    // COVERAGE_LABEL alone.
    const colWidths = subjects.map((subject) => {
      const rendered = years.map((year) => {
        const cell = cellFor(series.code, year, subject.slug);
        return cell ? renderCell(cell) : COVERAGE_LABEL.missing;
      });
      return Math.max(subject.name.length, ...rendered.map((r) => r.length));
    });
    const yearColWidth = Math.max(4, String(Math.max(...years)).length);

    const header = ["Year".padEnd(yearColWidth), ...subjects.map((s, i) => s.name.padEnd(colWidths[i]))].join("  | ");
    console.log(header);
    console.log("-".repeat(header.length));

    for (const year of years) {
      const row = [
        String(year).padEnd(yearColWidth),
        ...subjects.map((subject, i) => {
          const cell = cellFor(series.code, year, subject.slug);
          const text = cell ? renderCell(cell) : COVERAGE_LABEL.missing;
          return text.padEnd(colWidths[i]);
        }),
      ].join("  | ");
      console.log(row);
    }
  }
}

// --- dispatch ---------------------------------------------------------------

const USAGE = `SI Past Papers admin CLI

Usage: npm run cli -- <command> [options]

Commands:
  ingest <file> --series <code> --year <yyyy> --subject <slug> [--type <type>] [--paper-no <no>] [--source <org>] [--source-url <url>] [--attribution <text>] [--dry-run]
      Hash + store one file and insert its artifact/rights records.

  ingest <directory> --series <code> --year <yyyy> --subject <slug> [--source <org>] [--source-url <url>] [--attribution <text>] [--dry-run]
      Batch-ingest every .pdf in <directory>. Each file's artifact type
      and paper number are inferred from its filename:
      <artifact-type-slug>_<paper-no>.pdf (e.g. question-paper_1.pdf).

      --dry-run prints a table of every file with its inferred type/paper
      number (or why it can't be parsed / isn't a valid PDF) and makes NO
      database or storage changes. Run this before any real batch.

  approve-rights <artifact-id> --basis <${BASIS_CHOICES.join("|")}> --approved-by <name> --evidence-uri <uri> [--rights-status permission_granted|public_domain_or_expired] [--expiry <yyyy-mm-dd>] [--notes <text>]
      Record the institutional rights decision. Required before publish.

      --basis is a fixed enum, not free text:
        teacher-verified          Verified via a personal network of
                                   teachers, education officers, or former
                                   students. The primary verification path
                                   in current use — NOT an institutional
                                   confirmation.
        personal-collection        From the operator's own archive, with
                                   no separate third-party verification.
        institutional-submission   Directly submitted/authorized by an
                                   institution (e.g. MEHRD, a school) as
                                   rights holder or authorized source.
        other                      Anything else — explain via --notes.

      --approved-by is currently just the name of whoever is doing this
      verification (e.g. you), NOT an institutional sign-off — MEHRD has
      not been approached yet. Do not read a filled-in approved_by as
      Ministry endorsement. Revisit this once a real MEHRD approval
      process exists (see PROJECT_SPEC.md section 11.2).

  approve-rights --series <code> --year-range <yyyy-yyyy> --basis <${BASIS_CHOICES.join("|")}> --approved-by <name> --evidence-uri <uri> [--rights-status ...] [--expiry <yyyy-mm-dd>] [--notes <text>] [--confirm]
      Bulk form of approve-rights: applies the same basis/approved-by/
      evidence-uri/notes to every artifact in one exam series whose year
      falls in the inclusive range, skipping any that already have rights
      approved. Without --confirm this only prints which artifacts would
      be approved (and which are already approved and being skipped) and
      makes no changes — same dry-run-by-default pattern as ingest. Cannot
      be combined with a single <artifact-id>.

  publish <artifact-id>
      Mark an artifact published. Refuses (and prints what's missing) if
      its rights record does not yet have basis, approved_by and
      evidence_uri all set, or its stored file isn't there. A paper that
      was unpublished has its file moved back from quarantine to its
      original key first.

  publish --series <code> --year-range <yyyy-yyyy> [--confirm]
      Bulk form of publish: publishes every artifact in one exam series
      whose year falls in the inclusive range and whose rights are already
      approved. Artifacts that are already published, or whose rights
      aren't approved yet, are skipped with an explanation instead of
      attempted. Without --confirm this only prints what would happen —
      same dry-run-by-default pattern as ingest. Cannot be combined with a
      single <artifact-id>.

  unpublish <artifact-id> [--status withdrawn|rights_hold] [--reason <text>]
      Take a published artifact back off the public site. Also moves its
      stored file(s) to quarantine/<timestamp>/<original key> (bytes kept,
      logged), so any download link already handed out stops working
      immediately rather than when it expires (up to 10 minutes).
      Publishing it again moves the file(s) back.

  unpublish <artifact-id> --purge [--confirm] [--reason <text>]
      As above (or, for a paper that's already unpublished, just makes sure
      its files are in quarantine), then lists the quarantined files that
      would be PERMANENTLY deleted. Only with --confirm are they deleted --
      each logged in audit_events as file_purged with its key, sha256 and
      size. A purged paper can't be published again unless re-ingested.

  list
      List every artifact with its id, status and rights status.

  coverage
      Print the year x subject coverage matrix.

  rights-expiring --days <N>
      List published papers whose rights expire within N days (soonest
      first), plus published papers already HIDDEN from the public site
      because their rights expired or are no longer approved.

  inspect-object (--key <storage-key> | --file-id <id>)
      R2 only, read-only. Show the headers R2 has stored for one file, then
      fetch it through a real presigned R2 link and show the headers R2
      actually sends back (plus the link, to try in a browser).

  set-disposition (--key <storage-key> | --file-id <id>)
      R2 only. Set one file's stored serving headers, without changing its
      bytes: Content-Type: application/pdf, Cache-Control: private,
      max-age=600, and Content-Disposition: inline with its readable file
      name (ASCII filename + UTF-8 filename*). Then show the before/after
      headers and the presigned-link check. New ingests get these
      automatically.

  set-disposition --all [--confirm]
      Same for every file in the database. Without --confirm this only
      prints how many would change, with a few examples -- same
      dry-run-by-default pattern as ingest.
`;

async function main(): Promise<void> {
  // `process.argv` is the full list of words typed on the command line to
  // start this program (the first two are always the path to Node itself
  // and to this script, hence `.slice(2)` to drop those). `...rest` in
  // array destructuring (see artifact-naming.ts for the basic idea) means
  // "put the first item in `command`, and gather every remaining item into
  // a new array called `rest`" -- e.g. running `ingest myfile.pdf --series
  // sisc-l1` makes `command` "ingest" and `rest` the rest of those words.
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  switch (command) {
    case "ingest":
      await runIngest(args);
      break;
    case "approve-rights":
      await runApproveRights(args);
      break;
    case "publish":
      await runPublish(args);
      break;
    case "unpublish":
      await runUnpublish(args);
      break;
    case "list":
      await runList();
      break;
    case "coverage":
      await runCoverage();
      break;
    case "rights-expiring":
      await runRightsExpiring(args);
      break;
    case "inspect-object":
      await runInspectObject(args);
      break;
    case "set-disposition":
      await runSetDisposition(args);
      break;
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
