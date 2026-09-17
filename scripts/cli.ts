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
  getCoverageMatrix,
  ingestArtifact,
  listAllArtifacts,
  publishArtifact,
  unpublishArtifact,
  type CoverageStatus,
} from "@/lib/db/queries";
import { artifactTypeSlug } from "@/lib/artifact-naming";
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
    console.error(`Cannot publish ${artifactId} — rights record is missing: ${result.missing.join(", ")}`);
    console.error(`Run "approve-rights ${artifactId} --basis ... --approved-by ... --evidence-uri ..." first.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Published "${result.title}" (${artifactId}).`);
}

const UNPUBLISH_STATUS_CHOICES: ArtifactStatus[] = ["withdrawn", "rights_hold"];

async function runUnpublish(args: ParsedArgs): Promise<void> {
  const artifactId = args.positional[0];
  if (!artifactId) fail("Usage: unpublish <artifact-id> [--status withdrawn|rights_hold] [--reason <text>]");

  const status = (args.flags.status ?? "withdrawn") as ArtifactStatus;
  if (!UNPUBLISH_STATUS_CHOICES.includes(status)) {
    fail(`--status must be one of ${UNPUBLISH_STATUS_CHOICES.join(", ")}`);
  }

  const result = await unpublishArtifact(artifactId, status as "withdrawn" | "rights_hold", args.flags.reason ?? null);
  console.log(`Unpublished "${result.title}" (${artifactId}) -> ${status}.`);
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

// --- coverage ---------------------------------------------------------------

const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  published: "Published",
  verified_pending_rights: "Rights pending",
  missing: "Missing",
  not_yet_recovered: "Not yet recovered",
};

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

    const colWidths = subjects.map((s) =>
      Math.max(s.name.length, ...Object.values(COVERAGE_LABEL).map((l) => l.length))
    );
    const yearColWidth = Math.max(4, String(Math.max(...years)).length);

    const header = ["Year".padEnd(yearColWidth), ...subjects.map((s, i) => s.name.padEnd(colWidths[i]))].join("  | ");
    console.log(header);
    console.log("-".repeat(header.length));

    for (const year of years) {
      const row = [
        String(year).padEnd(yearColWidth),
        ...subjects.map((subject, i) => {
          const cell = cellFor(series.code, year, subject.slug);
          const status = cell?.status ?? "missing";
          return COVERAGE_LABEL[status].padEnd(colWidths[i]);
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
      evidence_uri all set.

  publish --series <code> --year-range <yyyy-yyyy> [--confirm]
      Bulk form of publish: publishes every artifact in one exam series
      whose year falls in the inclusive range and whose rights are already
      approved. Artifacts that are already published, or whose rights
      aren't approved yet, are skipped with an explanation instead of
      attempted. Without --confirm this only prints what would happen —
      same dry-run-by-default pattern as ingest. Cannot be combined with a
      single <artifact-id>.

  unpublish <artifact-id> [--status withdrawn|rights_hold] [--reason <text>]
      Take a published artifact back off the public site.

  list
      List every artifact with its id, status and rights status.

  coverage
      Print the year x subject coverage matrix.
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
