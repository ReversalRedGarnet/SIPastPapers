import { randomUUID, createHash } from "node:crypto";
import { unstable_cache } from "next/cache";
import { query, queryOne, queryWithoutRetry, withTransaction } from "./client";
import { getStorageProvider } from "@/lib/storage";
import { buildStorageKey } from "@/lib/storage/types";
import {
  artifactSlug,
  artifactTypeSlug,
  generateArtifactTitle,
  generateCanonicalFileName,
} from "@/lib/artifact-naming";
import type {
  ArtifactStatus,
  ArtifactType,
  ExamSeries,
  PublicExamRecord,
  RightsStatus,
  Source,
  Subject,
  VerificationStatus,
} from "@/types/domain";

// --- row shapes as they come back from postgres (snake_case) ---------------

interface ExamSeriesRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

interface SubjectRow {
  id: string;
  canonical_name: string;
  // jsonb column — the pg driver parses this into a real array already,
  // unlike the sqlite version's TEXT column which needed JSON.parse().
  aliases: string[];
  subject_code: string | null;
}

interface ArtifactBaseRow {
  id: string;
  exam_instance_id: string;
  subject_id: string;
  type: ArtifactType;
  paper_no: string | null;
  title: string;
  status: ArtifactStatus;
  published_at: string | null;
  year: number;
  series_code: string;
  series_name: string;
  subject_name: string;
  subject_slug: string | null;
}

interface RightsRow {
  rights_status: RightsStatus;
}

/**
 * One row of PUBLIC_ARTIFACT_SELECT below — the artifact base fields plus
 * its most-recent file/source/verification/rights, all fetched in the same
 * query via LATERAL joins instead of hydratePublicRecord issuing four
 * follow-up queries per row (an N+1 that made list pages like /results and
 * the homepage's "Recently added" cost four extra round trips per record
 * instead of zero). Left-joined, so the file/source/verification/rights
 * columns are null when an artifact has none yet.
 */
interface PublicArtifactRow extends ArtifactBaseRow {
  file_id: string | null;
  file_sha256: string | null;
  file_mime: string | null;
  file_bytes: number | null;
  source_type: string | null;
  source_organization: string | null;
  source_attribution: string | null;
  verification_status: VerificationStatus | null;
  rights_status: RightsStatus | null;
}

// --- mapping helpers ---------------------------------------------------------

function toExamSeries(row: ExamSeriesRow): ExamSeries {
  return { id: row.id, code: row.code, name: row.name, description: row.description };
}

function toSubject(row: SubjectRow): Subject {
  return {
    id: row.id,
    canonicalName: row.canonical_name,
    aliases: row.aliases ?? [],
    subjectCode: row.subject_code,
  };
}

const ARTIFACT_BASE_SELECT = `
  select
    a.id, a.exam_instance_id, a.subject_id, a.type, a.paper_no, a.title,
    a.status, a.published_at,
    ei.year as year,
    es.code as series_code, es.name as series_name,
    s.canonical_name as subject_name, s.subject_code as subject_slug
  from artifacts a
  join exam_instances ei on ei.id = a.exam_instance_id
  join exam_series es on es.id = ei.exam_series_id
  join subjects s on s.id = a.subject_id
`;

/**
 * Same base join as ARTIFACT_BASE_SELECT, plus each artifact's most-recent
 * file/source/verification/rights via LEFT JOIN LATERAL — one round trip
 * for however many rows match, instead of the base query plus four more
 * per row. Used by the public read paths (searchPublicArtifacts,
 * listRecentPublicArtifacts, getPublicArtifactBySlug); the CLI's
 * list/bulk functions still use the plain ARTIFACT_BASE_SELECT above via
 * hydrateArtifactSummary, unchanged.
 */
const PUBLIC_ARTIFACT_SELECT = `
  select
    a.id, a.exam_instance_id, a.subject_id, a.type, a.paper_no, a.title,
    a.status, a.published_at,
    ei.year as year,
    es.code as series_code, es.name as series_name,
    s.canonical_name as subject_name, s.subject_code as subject_slug,
    f.id as file_id, f.sha256 as file_sha256, f.mime as file_mime,
    f.bytes as file_bytes,
    src.source_type as source_type, src.organization as source_organization,
    src.attribution as source_attribution,
    v.status as verification_status,
    r.rights_status as rights_status
  from artifacts a
  join exam_instances ei on ei.id = a.exam_instance_id
  join exam_series es on es.id = ei.exam_series_id
  join subjects s on s.id = a.subject_id
  left join lateral (
    select id, sha256, mime, bytes
    from files
    where artifact_id = a.id
    order by created_at desc
    limit 1
  ) f on true
  left join lateral (
    select src2.source_type, src2.organization, src2.attribution
    from artifact_sources asrc
    join sources src2 on src2.id = asrc.source_id
    where asrc.artifact_id = a.id
    order by asrc.is_primary desc
    limit 1
  ) src on true
  left join lateral (
    select status
    from verifications
    where artifact_id = a.id
    order by checked_at desc
    limit 1
  ) v on true
  left join lateral (
    select rights_status
    from rights_records
    where artifact_id = a.id
    order by created_at desc
    limit 1
  ) r on true
`;

function hydratePublicRecord(row: PublicArtifactRow): PublicExamRecord {
  return {
    id: row.id,
    slug: artifactSlug({ artifactType: row.type, paperNo: row.paper_no }),
    examSeriesCode: row.series_code,
    examSeriesName: row.series_name,
    subjectSlug: row.subject_slug ?? "",
    subject: row.subject_name,
    year: row.year,
    artifactType: row.type,
    paperNumber: row.paper_no,
    title: row.title,
    status: row.status,
    verification: row.verification_status ?? "unverified",
    rights: row.rights_status ?? "unknown",
    file:
      row.file_id !== null
        ? { id: row.file_id, sha256: row.file_sha256!, mime: row.file_mime!, bytes: row.file_bytes! }
        : null,
    source:
      row.source_type !== null
        ? {
            type: row.source_type as Source["sourceType"],
            organization: row.source_organization,
            attribution: row.source_attribution,
          }
        : null,
  };
}

// --- reference data reads (used by public pages + the CLI) -----------------

export async function listExamSeries(): Promise<ExamSeries[]> {
  const rows = await query<ExamSeriesRow>("select * from exam_series order by name");
  return rows.map(toExamSeries);
}

export async function listSubjects(): Promise<Subject[]> {
  const rows = await query<SubjectRow>("select * from subjects order by canonical_name");
  return rows.map(toSubject);
}

export async function listYears(): Promise<number[]> {
  const rows = await query<{ year: number }>("select distinct year from exam_instances order by year");
  return rows.map((r) => r.year);
}

// --- public reads ------------------------------------------------------

const PUBLIC_STATUSES = "('published', 'not_yet_recovered')";

export interface ExamContentAvailability {
  /** exam series codes with at least one publicly-visible artifact in any year */
  seriesWithContent: Set<string>;
  /** "seriesCode:year" pairs with at least one publicly-visible artifact */
  yearsWithContent: Set<string>;
}

/**
 * One aggregate query answering "does this series / this series+year have
 * any public content at all", for every series and year at once. The browse
 * drill-down (src/lib/browse-years.ts) shows a fixed placeholder year range
 * per series regardless of what's actually been ingested, so the sidebar
 * and year-list pages need this availability data to show a "no content
 * yet" indicator -- computed once per page render and reused for both,
 * rather than a per-row existence check (which at 3 series x 11 years would
 * reintroduce the N+1 pattern the earlier hydratePublicRecord fix removed).
 */
export async function getExamContentAvailability(): Promise<ExamContentAvailability> {
  const rows = await query<{ series_code: string; year: number }>(
    `select distinct es.code as series_code, ei.year as year
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     where a.status in ${PUBLIC_STATUSES}`
  );
  const seriesWithContent = new Set<string>();
  const yearsWithContent = new Set<string>();
  for (const row of rows) {
    seriesWithContent.add(row.series_code);
    yearsWithContent.add(`${row.series_code}:${row.year}`);
  }
  return { seriesWithContent, yearsWithContent };
}

export async function searchPublicArtifacts(filters: {
  q?: string;
  series?: string;
  year?: string;
  subject?: string;
}): Promise<PublicExamRecord[]> {
  const clauses: string[] = [`a.status in ${PUBLIC_STATUSES}`];
  const params: (string | number)[] = [];

  if (filters.series) {
    params.push(filters.series);
    clauses.push(`es.code = $${params.length}`);
  }
  if (filters.year) {
    params.push(Number(filters.year));
    clauses.push(`ei.year = $${params.length}`);
  }
  if (filters.subject) {
    params.push(filters.subject);
    clauses.push(`s.subject_code = $${params.length}`);
  }

  const sql = `${PUBLIC_ARTIFACT_SELECT} where ${clauses.join(" and ")} order by ei.year desc, s.canonical_name`;
  const rows = await query<PublicArtifactRow>(sql, params);
  let records = rows.map(hydratePublicRecord);

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    records = records.filter((r) =>
      `${r.title} ${r.subject} ${r.examSeriesName} ${r.year}`.toLowerCase().includes(q)
    );
  }

  return records;
}

/**
 * Cached wrapper around searchPublicArtifacts, for /results. That route
 * reads free-text searchParams (q, series, year, subject), which keeps a
 * page dynamic per-request in Next.js regardless of a route-segment
 * `revalidate` export -- so unlike the other public read paths, this one
 * can't be made ISR at the page level. Caching at the data layer instead:
 * repeated searches (including the unfiltered "show everything" case) hit
 * this cache for up to 60s instead of re-querying Postgres every request.
 */
export const searchPublicArtifactsCached = unstable_cache(
  searchPublicArtifacts,
  ["search-public-artifacts"],
  { revalidate: 60 }
);

export interface SubjectWithCount {
  slug: string;
  name: string;
  count: number;
}

/**
 * Subjects that have at least one publicly-visible artifact (published or
 * not_yet_recovered) for one exam instance — the "select a subject" step
 * of the browse drill-down. Subjects with nothing recorded yet are left
 * out rather than shown as a dead-end "0 papers" row.
 */
export async function listPublicSubjectsForInstance(
  seriesCode: string,
  year: number
): Promise<SubjectWithCount[]> {
  const rows = await query<{ slug: string | null; name: string; count: string }>(
    `select s.subject_code as slug, s.canonical_name as name, count(*) as count
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join subjects s on s.id = a.subject_id
     where es.code = $1 and ei.year = $2 and a.status in ${PUBLIC_STATUSES}
     group by s.id
     order by s.canonical_name`,
    [seriesCode, year]
  );
  return rows.map((r) => ({ slug: r.slug ?? "", name: r.name, count: Number(r.count) }));
}

export interface DownloadableYearFile {
  fileId: string;
  storageKey: string;
  title: string;
}

/**
 * Every downloadable file for one exam instance's "Download all" zip —
 * status = 'published' only (unlike listPublicSubjectsForInstance's
 * PUBLIC_STATUSES, a 'not_yet_recovered' placeholder has no file to
 * include), joined to files so an artifact with no file row is left out
 * rather than producing a null entry.
 */
export async function listPublishedFilesForInstance(
  seriesCode: string,
  year: number
): Promise<DownloadableYearFile[]> {
  const rows = await query<{ file_id: string; storage_key: string; title: string }>(
    `select f.id as file_id, f.storage_key, a.title
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join files f on f.artifact_id = a.id
     where es.code = $1 and ei.year = $2 and a.status = 'published'
     order by a.title`,
    [seriesCode, year]
  );
  return rows.map((r) => ({ fileId: r.file_id, storageKey: r.storage_key, title: r.title }));
}

/** Most recently published artifacts, for the homepage "Recently added" list. */
export async function listRecentPublicArtifacts(limit: number): Promise<PublicExamRecord[]> {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT} where a.status = 'published' order by a.published_at desc limit $1`,
    [limit]
  );
  return rows.map(hydratePublicRecord);
}

export async function getPublicArtifactBySlug(
  seriesCode: string,
  year: number,
  subjectSlug: string,
  slug: string
): Promise<{ record: PublicExamRecord; related: PublicExamRecord[] } | undefined> {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT}
     where a.status in ${PUBLIC_STATUSES} and es.code = $1 and ei.year = $2 and s.subject_code = $3`,
    [seriesCode, year, subjectSlug]
  );

  const match = rows.find(
    (r) => artifactSlug({ artifactType: r.type, paperNo: r.paper_no }) === slug
  );
  if (!match) return undefined;

  const record = hydratePublicRecord(match);
  const related = rows.filter((r) => r.id !== match.id).map(hydratePublicRecord);

  return { record, related };
}

/**
 * Every publicly-visible artifact for one (series, subject) across all
 * years, oldest first, then by artifact type and paper number -- the
 * ordering a reader would browse a subject's papers in. Used by the
 * artifact detail page to derive prev/next navigation and the "other years
 * for this subject" list from a single extra query, rather than a per-row
 * existence check for each candidate neighbour.
 */
export async function listSubjectArtifacts(
  seriesCode: string,
  subjectSlug: string
): Promise<PublicExamRecord[]> {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT}
     where a.status in ${PUBLIC_STATUSES} and es.code = $1 and s.subject_code = $2
     order by ei.year asc, a.type asc, a.paper_no asc nulls first`,
    [seriesCode, subjectSlug]
  );
  return rows.map(hydratePublicRecord);
}

// --- CLI: coverage matrix (spec section 11.3) -----------------------------

export type CoverageStatus = "published" | "verified_pending_rights" | "missing" | "not_yet_recovered";

export interface CoverageCell {
  examSeriesCode: string;
  examSeriesName: string;
  year: number;
  subjectSlug: string;
  subjectName: string;
  status: CoverageStatus;
}

export async function getCoverageMatrix(): Promise<CoverageCell[]> {
  const instances = await query<{ id: string; year: number; series_code: string; series_name: string }>(
    `select ei.id, ei.year, es.code as series_code, es.name as series_name
     from exam_instances ei
     join exam_series es on es.id = ei.exam_series_id
     order by es.name, ei.year`
  );

  const subjects = await query<{ id: string; canonical_name: string; subject_code: string | null }>(
    "select id, canonical_name, subject_code from subjects order by canonical_name"
  );

  const artifactStatuses = await query<{
    exam_instance_id: string;
    subject_id: string;
    status: ArtifactStatus;
  }>("select exam_instance_id, subject_id, status from artifacts");

  const statusesByCell = new Map<string, ArtifactStatus[]>();
  for (const a of artifactStatuses) {
    const key = `${a.exam_instance_id}:${a.subject_id}`;
    const list = statusesByCell.get(key) ?? [];
    list.push(a.status);
    statusesByCell.set(key, list);
  }

  function deriveStatus(statuses: ArtifactStatus[] | undefined): CoverageStatus {
    if (!statuses || statuses.length === 0) return "missing";
    if (statuses.includes("published")) return "published";
    if (statuses.includes("not_yet_recovered")) return "not_yet_recovered";
    return "verified_pending_rights";
  }

  const cells: CoverageCell[] = [];
  for (const instance of instances) {
    for (const subject of subjects) {
      const key = `${instance.id}:${subject.id}`;
      cells.push({
        examSeriesCode: instance.series_code,
        examSeriesName: instance.series_name,
        year: instance.year,
        subjectSlug: subject.subject_code ?? subject.id,
        subjectName: subject.canonical_name,
        status: deriveStatus(statusesByCell.get(key)),
      });
    }
  }
  return cells;
}

// --- CLI: ingest (spec section 6, 13.4) -------------------------------------

export interface IngestArtifactInput {
  examSeriesCode: string;
  year: number;
  subjectSlug: string;
  artifactType: ArtifactType;
  paperNo: string | null;
  file: { buffer: Buffer; mime: string };
  sourceOrganization?: string | null;
  sourceUrl?: string | null;
  attribution?: string | null;
}

export interface IngestArtifactResult {
  artifactId: string;
  title: string;
  storageKey: string;
  sha256: string;
}

/**
 * Ingest one file: hash it, write it to storage, insert the artifact +
 * file row, and — regardless of any rights information the caller also
 * supplied — always create a rights_records row pinned to
 * `pending_institutional_approval` with no basis/evidence/approver yet.
 * The submitter (the CLI operator running `ingest`) cannot set the rights
 * decision directly; that only happens via `approveRights`, and only after
 * that can `publishArtifact` succeed (spec section 6.3: "Rights status
 * must be resolved before PUBLIC status").
 */
export async function ingestArtifact(input: IngestArtifactInput): Promise<IngestArtifactResult> {
  const series = await queryOne<ExamSeriesRow>("select * from exam_series where code = $1", [
    input.examSeriesCode,
  ]);
  if (!series) throw new Error(`Unknown exam series: ${input.examSeriesCode}`);

  const subject = await queryOne<SubjectRow>("select * from subjects where subject_code = $1", [
    input.subjectSlug,
  ]);
  if (!subject) throw new Error(`Unknown subject: ${input.subjectSlug}`);

  const title = generateArtifactTitle({
    examSeriesName: series.name,
    subjectName: subject.canonical_name,
    year: input.year,
    artifactType: input.artifactType,
    paperNo: input.paperNo,
  });

  // Storage write happens before the DB transaction, and outside it, since
  // a storage failure should mean nothing is written to the database at
  // all. If the DB transaction below fails after a successful write, the
  // file is orphaned in storage rather than referenced by a row —
  // acceptable for now; a real ingestion pipeline would reconcile orphans
  // via the storage/DB export described in spec section 16.3.
  const sha256 = createHash("sha256").update(input.file.buffer).digest("hex");
  const fileName = generateCanonicalFileName({
    examSeriesSlug: series.code,
    year: input.year,
    subjectSlug: subject.subject_code ?? subject.id,
    artifactType: input.artifactType,
    paperNo: input.paperNo,
  });
  const storageKey = buildStorageKey({
    examSeriesSlug: series.code,
    year: input.year,
    subjectSlug: subject.subject_code ?? subject.id,
    artifactType: artifactTypeSlug(input.artifactType),
    fileName,
  });
  await getStorageProvider().put(storageKey, input.file.buffer, input.file.mime);

  return withTransaction(async () => {
    let examInstance = await queryOne<{ id: string }>(
      "select id from exam_instances where exam_series_id = $1 and year = $2",
      [series.id, input.year]
    );
    if (!examInstance) {
      const id = randomUUID();
      await query(
        "insert into exam_instances (id, exam_series_id, year, official_name) values ($1, $2, $3, null)",
        [id, series.id, input.year]
      );
      examInstance = { id };
    }

    const duplicate = await queryOne<{ id: string }>(
      `select id from artifacts
       where exam_instance_id = $1 and subject_id = $2 and type = $3
         and ((paper_no is null and $4::text is null) or paper_no = $4::text)`,
      [examInstance.id, subject.id, input.artifactType, input.paperNo]
    );
    if (duplicate) {
      throw new Error(
        `An artifact already exists for this exam / subject / type / paper number (id ${duplicate.id}). Edit the existing record instead of creating a duplicate.`
      );
    }

    const artifactId = randomUUID();
    await query(
      `insert into artifacts
         (id, exam_instance_id, subject_id, type, paper_no, title, status, published_at)
       values ($1, $2, $3, $4, $5, $6, 'pending_review', null)`,
      [artifactId, examInstance.id, subject.id, input.artifactType, input.paperNo, title]
    );

    await query(
      `insert into files (id, artifact_id, storage_key, sha256, mime, bytes)
       values ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), artifactId, storageKey, sha256, input.file.mime, input.file.buffer.byteLength]
    );

    if (input.sourceOrganization) {
      const sourceId = randomUUID();
      const inferredType = /mehrd/i.test(input.sourceOrganization) ? "mehrd" : "other";
      await query(
        `insert into sources (id, source_type, organization, person_label, url, attribution)
         values ($1, $2, $3, null, $4, $5)`,
        [sourceId, inferredType, input.sourceOrganization, input.sourceUrl ?? null, input.attribution ?? null]
      );
      await query(
        `insert into artifact_sources (artifact_id, source_id, is_primary, notes)
         values ($1, $2, true, null)`,
        [artifactId, sourceId]
      );
    }

    await query(
      `insert into rights_records
         (id, artifact_id, rights_status, basis, evidence_uri, approved_by, approved_at, expiry_date, notes)
       values ($1, $2, 'pending_institutional_approval', null, null, null, null, null, null)`,
      [randomUUID(), artifactId]
    );

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_created', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ title, sha256 })]
    );

    return { artifactId, title, storageKey, sha256 };
  });
}

// --- file serving (spec section 3.3: direct PDF download must always work) -

export interface DownloadableFile {
  storageKey: string;
  mime: string;
  bytes: number;
  title: string;
}

/**
 * Only ever returns a file for an artifact whose CURRENT status is
 * "published" — checked live against the database on every call, not
 * cached, so a later rights_hold/withdrawal takes effect immediately.
 */
export async function getFileForDownload(fileId: string): Promise<DownloadableFile | undefined> {
  const row = await queryOne<{
    storage_key: string;
    mime: string;
    bytes: number;
    status: ArtifactStatus;
    title: string;
  }>(
    `select f.storage_key, f.mime, f.bytes, a.status, a.title
     from files f
     join artifacts a on a.id = f.artifact_id
     where f.id = $1`,
    [fileId]
  );

  if (!row || row.status !== "published") return undefined;
  return { storageKey: row.storage_key, mime: row.mime, bytes: row.bytes, title: row.title };
}

// --- issues (spec section 8.5: correction/takedown intake) -----------------

export async function createIssue(input: {
  artifactId: string;
  issueType: string;
  description: string;
  contact: string | null;
}): Promise<void> {
  // queryWithoutRetry, not query: this INSERT isn't wrapped in a
  // transaction and issues has no unique constraint to make a retry
  // idempotent, so a connection reset between send and ack must fail once
  // rather than risk silently inserting the same issue twice.
  await queryWithoutRetry(
    `insert into issues (id, artifact_id, issue_type, description, contact, status)
     values ($1, $2, $3, $4, $5, 'open')`,
    [randomUUID(), input.artifactId, input.issueType, input.description, input.contact]
  );
}

// --- CLI: artifact list + rights approval + publish/unpublish (spec 6.3, 8.5) -

export interface ArtifactSummary {
  id: string;
  title: string;
  examSeriesName: string;
  year: number;
  subjectName: string;
  artifactType: ArtifactType;
  paperNumber: string | null;
  status: ArtifactStatus;
  rightsStatus: RightsStatus;
  hasFile: boolean;
}

async function hydrateArtifactSummary(row: ArtifactBaseRow): Promise<ArtifactSummary> {
  const rights = await queryOne<RightsRow>(
    "select rights_status from rights_records where artifact_id = $1 order by created_at desc limit 1",
    [row.id]
  );
  const fileCount = await queryOne<{ n: string }>(
    "select count(*) as n from files where artifact_id = $1",
    [row.id]
  );
  return {
    id: row.id,
    title: row.title,
    examSeriesName: row.series_name,
    year: row.year,
    subjectName: row.subject_name,
    artifactType: row.type,
    paperNumber: row.paper_no,
    status: row.status,
    rightsStatus: rights?.rights_status ?? "unknown",
    hasFile: Number(fileCount?.n ?? 0) > 0,
  };
}

export async function listAllArtifacts(): Promise<ArtifactSummary[]> {
  const rows = await query<ArtifactBaseRow>(
    `${ARTIFACT_BASE_SELECT} order by ei.year desc, es.name, s.canonical_name`
  );
  return Promise.all(rows.map(hydrateArtifactSummary));
}

/**
 * Artifacts for one exam series within an inclusive year range — the
 * candidate set for the CLI's bulk `approve-rights`/`publish` modes (see
 * scripts/cli-lib.ts), which act on a whole (series, year-range) batch
 * instead of one artifact at a time.
 */
export async function listArtifactsBySeriesYearRange(
  seriesCode: string,
  yearFrom: number,
  yearTo: number
): Promise<ArtifactSummary[]> {
  const rows = await query<ArtifactBaseRow>(
    `${ARTIFACT_BASE_SELECT} where es.code = $1 and ei.year between $2 and $3 order by ei.year, s.canonical_name`,
    [seriesCode, yearFrom, yearTo]
  );
  return Promise.all(rows.map(hydrateArtifactSummary));
}

/**
 * Records the institutional rights decision on an artifact's most recent
 * rights_records row: who approved it, on what basis, and the evidence
 * backing it up. This is the only way those three fields get filled in —
 * `ingestArtifact` always leaves them null. `publishArtifact` refuses to
 * run until all three are set (spec section 6.3, section 8.3).
 */
export async function approveRights(
  artifactId: string,
  input: {
    basis: string;
    approvedBy: string;
    evidenceUri: string;
    rightsStatus?: Extract<RightsStatus, "permission_granted" | "public_domain_or_expired">;
    expiryDate?: string | null;
    notes?: string | null;
  }
): Promise<{ rightsStatus: RightsStatus }> {
  const artifact = await queryOne<{ id: string }>("select id from artifacts where id = $1", [artifactId]);
  if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);

  const rights = await queryOne<{ id: string }>(
    "select id from rights_records where artifact_id = $1 order by created_at desc limit 1",
    [artifactId]
  );
  if (!rights) throw new Error(`Artifact ${artifactId} has no rights record.`);

  const rightsStatus = input.rightsStatus ?? "permission_granted";
  const now = new Date().toISOString();

  return withTransaction(async () => {
    await query(
      `update rights_records
       set rights_status = $1, basis = $2, evidence_uri = $3, approved_by = $4, approved_at = $5,
           expiry_date = $6, notes = $7
       where id = $8`,
      [rightsStatus, input.basis, input.evidenceUri, input.approvedBy, now, input.expiryDate ?? null, input.notes ?? null, rights.id]
    );

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'rights_approved', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ rightsStatus, approvedBy: input.approvedBy })]
    );

    return { rightsStatus };
  });
}

export interface RightsGateStatus {
  satisfied: boolean;
  missing: string[];
}

/**
 * Exported (not just used internally by publishArtifact) so the CLI's bulk
 * publish mode can pre-check every candidate artifact and report exactly
 * which ones lack rights approval, and why, before doing anything — see
 * scripts/cli-lib.ts's planBulkPublish.
 */
export async function checkRightsGate(artifactId: string): Promise<RightsGateStatus> {
  const rights = await queryOne<{ basis: string | null; approved_by: string | null; evidence_uri: string | null }>(
    "select basis, approved_by, evidence_uri from rights_records where artifact_id = $1 order by created_at desc limit 1",
    [artifactId]
  );

  const missing: string[] = [];
  if (!rights) {
    return { satisfied: false, missing: ["basis", "approved_by", "evidence_uri (no rights record at all)"] };
  }
  if (!rights.basis) missing.push("basis");
  if (!rights.approved_by) missing.push("approved_by");
  if (!rights.evidence_uri) missing.push("evidence_uri");
  return { satisfied: missing.length === 0, missing };
}

/**
 * The only place artifact status is ever set to "published". Unlike the
 * old admin UI's "Approve rights & publish" button, this does NOT resolve
 * the rights record itself — it only checks that `approveRights` has
 * already filled in basis, approved_by and evidence_uri, and refuses
 * (returning what's missing) otherwise. This is a new safeguard: rights
 * approval and publication are now two separate, explicit CLI steps.
 */
export async function publishArtifact(
  artifactId: string
): Promise<{ title: string } | { missing: string[] }> {
  const artifact = await queryOne<{ id: string; title: string; status: ArtifactStatus }>(
    "select id, title, status from artifacts where id = $1",
    [artifactId]
  );
  if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
  if (artifact.status === "published") return { title: artifact.title };

  const gate = await checkRightsGate(artifactId);
  if (!gate.satisfied) return { missing: gate.missing };

  return withTransaction(async () => {
    const now = new Date().toISOString();
    await query("update artifacts set status = 'published', published_at = $1 where id = $2", [
      now,
      artifactId,
    ]);

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_published', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({})]
    );

    return { title: artifact.title };
  });
}

/**
 * Flips a published artifact back to a non-public status and logs the
 * action. New command — the old admin UI had no way to un-publish once
 * published.
 */
export async function unpublishArtifact(
  artifactId: string,
  toStatus: Extract<ArtifactStatus, "withdrawn" | "rights_hold"> = "withdrawn",
  reason?: string | null
): Promise<{ title: string }> {
  const artifact = await queryOne<{ id: string; title: string; status: ArtifactStatus }>(
    "select id, title, status from artifacts where id = $1",
    [artifactId]
  );
  if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
  if (artifact.status !== "published") {
    throw new Error(`Artifact ${artifactId} is not published (status: ${artifact.status}).`);
  }

  return withTransaction(async () => {
    await query("update artifacts set status = $1 where id = $2", [toStatus, artifactId]);

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_unpublished', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ toStatus, reason: reason ?? null })]
    );

    return { title: artifact.title };
  });
}
