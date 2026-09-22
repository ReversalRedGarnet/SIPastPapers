import { randomUUID, createHash } from "node:crypto";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { query, queryOne, queryWithoutRetry, withTransaction } from "./client";
import { listBrowseYears } from "@/lib/browse-years";
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

// --- Below: shapes of the raw rows the database gives back. Postgres
// column names use underscores (snake_case), so these mirror that, and the
// "to..." functions further down convert them into the camelCase shapes
// the rest of the app uses. -------------------------------------------------

interface ExamSeriesRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

interface SubjectRow {
  id: string;
  canonical_name: string;
  // This column is stored as JSON in the database, but the database
  // library already turns it into a normal JavaScript array for us, so we
  // don't need to parse it ourselves.
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
 * One row of everything the PUBLIC_ARTIFACT_SELECT query below fetches:
 * the basic exam-paper details, plus its most recent file, source,
 * verification and rights info, all in one go. We fetch all of this
 * together, in a single query, so that showing a list of many papers
 * doesn't require a separate extra database trip for each one. Since an
 * exam paper might not have a file/source/verification/rights entry yet,
 * those fields can come back empty (null).
 */
// `extends` on an interface means "this includes everything ArtifactBaseRow
// already has, plus these extra fields" -- rather than retyping every field
// from ArtifactBaseRow again here, this just adds to it.
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

// --- Helpers that convert a raw database row into the shape the rest of
// the app expects to work with. ----------------------------------------------

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

// This whole thing is a SQL query, written as plain text (a template
// literal -- see src/lib/format.ts) and sent to Postgres to run. In plain
// English, it says: "Get these columns (id, type, title, and so on) from
// the `artifacts` table, and for each artifact, also pull in matching
// details from the `exam_instances`, `exam_series`, and `subjects` tables."
// A `join` is how SQL combines rows from separate tables that are related
// by a shared id -- e.g. `join exam_instances ei on ei.id =
// a.exam_instance_id` means "match each artifact to the one exam_instance
// row whose id equals the artifact's exam_instance_id." The short names
// (`a`, `ei`, `es`, `s`) are just local nicknames ("aliases") for each
// table, used so the rest of the query doesn't have to spell out the full
// table name every time.
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
 * Like ARTIFACT_BASE_SELECT above, but it also grabs each exam paper's
 * most recent file, source, verification, and rights info in the same
 * query, instead of running four extra queries per paper. This is what
 * powers the public-facing pages (search results, "recently added", and
 * an individual paper's page). The command-line tool's own list/bulk
 * features still use the simpler ARTIFACT_BASE_SELECT above.
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
  -- A plain "join" (above) only keeps a row if a match is found in the
  -- other table. A "left join" keeps the artifact row even when there's no
  -- match (e.g. no file has been uploaded for it yet) -- the extra columns
  -- just come back empty (null) in that case instead of dropping the whole
  -- row. "lateral (...)" runs a small query-within-a-query separately for
  -- each artifact row, here to fetch just its single most recently added
  -- file (order by created_at desc limit 1) -- this is what a "subquery"
  -- is: a query nested inside another query.
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
    // A `!` right after a value is a "non-null assertion": it tells
    // TypeScript "trust me, this specific value isn't actually null here,
    // even though its type says it could be." It's used here because we've
    // just checked `row.file_id !== null` above, so we (the programmer)
    // know the other file_* fields must be filled in too -- but TypeScript
    // can't work that connection out on its own from the check alone.
    file:
      row.file_id !== null
        ? { id: row.file_id, sha256: row.file_sha256!, mime: row.file_mime!, bytes: row.file_bytes! }
        : null,
    source:
      row.source_type !== null
        ? {
            // `Source["sourceType"]` reaches into the Source interface (see
            // src/types/domain.ts) and pulls out just the type of its
            // `sourceType` field, so this line means "treat this raw
            // database string as whatever type Source.sourceType expects"
            // (paired with `as`, the type assertion from artifact-naming.ts).
            type: row.source_type as Source["sourceType"],
            organization: row.source_organization,
            attribution: row.source_attribution,
          }
        : null,
  };
}

// --- Basic reference data lookups (exam series, subjects, years). Used by
// both the public website and the command-line tool. -----------------------

// The functions below are wrapped in React's `cache()`. This just means:
// if the same page needs the same piece of data twice while it's loading
// (which happens more often than you'd think), we only actually ask the
// database once, and reuse the answer the second time.
//
// We only do this for the read-only functions that pages actually render
// with. The command-line tool's functions are deliberately NOT wrapped
// this way, because the CLI can run several steps back-to-back in one go,
// and we don't want an earlier cached answer to hide the results of a
// change the CLI just made moments ago.
//
// `cache(async () => {...})` is a "higher-order function": cache() itself
// is a function whose job is to take another function and hand back a new,
// wrapped version of it with extra behavior added (here, remembering the
// result). The `async () => { ... }` part is the actual function being
// wrapped -- an arrow function (see artifact-naming.ts) that takes no
// inputs. Also, `rows.map(toExamSeries)` is the same `.map()` from
// earlier, just handed an existing named function to run on each item
// instead of writing a new inline one.
export const listExamSeries = cache(async (): Promise<ExamSeries[]> => {
  const rows = await query<ExamSeriesRow>("select * from exam_series order by name");
  return rows.map(toExamSeries);
});

export const listSubjects = cache(async (): Promise<Subject[]> => {
  const rows = await query<SubjectRow>("select * from subjects order by canonical_name");
  return rows.map(toSubject);
});

export const listYears = cache(async (): Promise<number[]> => {
  const rows = await query<{ year: number }>("select distinct year from exam_instances order by year");
  return rows.map((r) => r.year);
});

// --- public reads ------------------------------------------------------

const PUBLIC_STATUSES = "('published', 'not_yet_recovered')";

export interface ExamContentAvailability {
  /** Which exam series (e.g. "SIF3") have at least one paper visible to the public, in any year */
  seriesWithContent: Set<string>;
  /** Which specific "series:year" combinations (e.g. "SIF3:2019") have at least one visible paper */
  yearsWithContent: Set<string>;
}

/**
 * Answers "does this exam series, or this series+year, have any content at
 * all?" for every series and year in one single query. The browse pages
 * always show a fixed list of years per series (whether or not we've
 * actually got papers for them), so they need this to know which years to
 * mark as "nothing here yet". We compute it once and reuse it for both the
 * sidebar and the year list, rather than asking the database separately
 * for each individual year — which would get slow as more years are added.
 */
export const getExamContentAvailability = cache(async (): Promise<ExamContentAvailability> => {
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
});

export interface PublicArtifactFilters {
  q?: string;
  series?: string;
  year?: string;
  subject?: string;
}

/**
 * Builds the shared filtering logic (search box, series, year, subject)
 * used by both the plain search below and its paginated version, so the
 * two versions can never disagree about what a filter means.
 *
 * The keyword search (`q`) is done as a simple "contains this text"
 * database search. That's good enough for how much data this archive
 * currently has. A more advanced full-text search (which would rank
 * results by relevance and handle multi-word queries better) could be
 * added later, but isn't needed yet.
 */
function buildPublicArtifactFilterClauses(filters: PublicArtifactFilters): {
  clauses: string[];
  params: (string | number)[];
} {
  // `$1`, `$2`, etc. are "parameterized query" placeholders: instead of
  // gluing a visitor's actual search text directly into the SQL string
  // (which would let someone type something malicious into the search box
  // to manipulate the query -- an attack called "SQL injection"), the SQL
  // text just has numbered blanks, and the real values are sent alongside
  // it separately in the `params` list. Postgres itself safely fills in
  // blank $1 with params[0], $2 with params[1], and so on -- text typed by
  // a visitor is always treated as plain data, never as part of the query's
  // actual instructions. `$${params.length}` below just calculates which
  // numbered blank to use next, based on how many params have been added
  // to the list so far.
  const clauses: string[] = [`a.status in ${PUBLIC_STATUSES}`];
  const params: (string | number)[] = [];

  if (filters.series) {
    params.push(filters.series);
    clauses.push(`es.code = $${params.length}`);
  }
  // The year filter comes in as plain text from the page's URL, so we need
  // to convert it to a number ourselves. If someone typed something that
  // isn't a valid number (e.g. "abc"), we just ignore the year filter
  // entirely rather than showing an error — this is a search page, so a
  // bad filter should just mean "don't filter by year", not break the page.
  const year = filters.year ? Number(filters.year) : undefined;
  if (year !== undefined && Number.isInteger(year)) {
    params.push(year);
    clauses.push(`ei.year = $${params.length}`);
  }
  if (filters.subject) {
    params.push(filters.subject);
    clauses.push(`s.subject_code = $${params.length}`);
  }
  // `?.` ("optional chaining") means "only call .trim() if filters.q
  // actually has a value; if it's missing, just skip straight to
  // `undefined` instead of crashing by trying to call .trim() on nothing."
  const q = filters.q?.trim();
  if (q) {
    params.push(`%${q}%`);
    const p = `$${params.length}`;
    clauses.push(`(a.title ilike ${p} or s.canonical_name ilike ${p} or es.name ilike ${p})`);
  }

  return { clauses, params };
}

export const searchPublicArtifacts = cache(async (filters: PublicArtifactFilters): Promise<PublicExamRecord[]> => {
  const { clauses, params } = buildPublicArtifactFilterClauses(filters);
  const sql = `${PUBLIC_ARTIFACT_SELECT} where ${clauses.join(" and ")} order by ei.year desc, s.canonical_name`;
  const rows = await query<PublicArtifactRow>(sql, params);
  return rows.map(hydratePublicRecord);
});

/**
 * Same as searchPublicArtifacts above, but with the results cached for up
 * to 60 seconds so we don't hit the database on every single request.
 * Used by the sitemap, which needs "every public paper" with no filters.
 * The main search-results page uses the paginated cached version below
 * instead (searchPublicArtifactsPageCached).
 */
// `unstable_cache(...)` is Next.js's own caching helper (different from
// React's `cache()` used above -- see that comment for the distinction).
// It's another higher-order function: give it a function, a name to
// identify this cache entry by, and a duration, and it hands back a new
// version of that function which remembers its answer for that long,
// shared across every visitor, not just within one page load.
export const searchPublicArtifactsCached = unstable_cache(
  searchPublicArtifacts,
  ["search-public-artifacts"],
  { revalidate: 60 }
);

export const RESULTS_PAGE_SIZE = 25;
const RESULTS_MAX_PAGE_SIZE = 100;

export interface PublicArtifactPage {
  records: PublicExamRecord[];
  /** How many results match in total, across every page — not just how many are on this one page. */
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Same search as above, but split into pages instead of returning
 * everything at once — this is what powers the /results page, so it
 * doesn't have to load hundreds of exam papers onto one screen.
 *
 * If the page number or page size in the URL is invalid or out of range,
 * we quietly fall back to a sensible value instead of showing an error —
 * a results listing shouldn't break just because someone typed a strange
 * number in the URL. The page size also has a hard maximum, so nobody can
 * use the URL to force it back into loading everything at once.
 *
 * We don't need React's request-level caching here, since this function is
 * only ever called once per page load anyway.
 */
export async function searchPublicArtifactsPage(
  filters: PublicArtifactFilters,
  pagination: { page?: number; limit?: number }
): Promise<PublicArtifactPage> {
  const limit = Math.min(
    Math.max(1, Number.isInteger(pagination.limit) ? (pagination.limit as number) : RESULTS_PAGE_SIZE),
    RESULTS_MAX_PAGE_SIZE
  );
  const page = Math.max(1, Number.isInteger(pagination.page) ? (pagination.page as number) : 1);
  const offset = (page - 1) * limit;

  const { clauses, params } = buildPublicArtifactFilterClauses(filters);
  const where = clauses.join(" and ");

  // We run two separate queries here: one for this page's results, and
  // one just to count the total matches. A single combined query can give
  // the wrong total when someone requests a page number that's past the
  // last page, so it's simpler and more reliable to keep them separate.
  // We run both at the same time (rather than one after the other) so
  // this doesn't take any longer than a single query would.
  //
  // `...params` is the "spread" operator: it unpacks all the items already
  // in `params` into this new array, so `dataParams` ends up as "everything
  // that was in params, plus limit, plus offset" -- without spread, this
  // would need a loop to copy each item across one at a time.
  // `Promise.all` again (see src/app/page.tsx) -- both queries run together.
  const dataParams = [...params, limit, offset];
  const [rows, countRows] = await Promise.all([
    query<PublicArtifactRow>(
      `${PUBLIC_ARTIFACT_SELECT} where ${where} order by ei.year desc, s.canonical_name limit $${dataParams.length - 1} offset $${dataParams.length}`,
      dataParams
    ),
    query<{ total: string }>(`select count(*) as total from (${PUBLIC_ARTIFACT_SELECT} where ${where}) sub`, params),
  ]);

  const total = Number(countRows[0]?.total ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return { records: rows.map(hydratePublicRecord), total, page, limit, totalPages };
}

/**
 * Same as searchPublicArtifactsPage above, but with the results cached for
 * a short time so repeated identical searches don't have to hit the
 * database each time. Each distinct combination of filters + page number
 * gets its own cache entry, so different searches never mix results.
 */
export const searchPublicArtifactsPageCached = unstable_cache(
  searchPublicArtifactsPage,
  ["search-public-artifacts-page"],
  { revalidate: 60 }
);

export interface SubjectWithCount {
  slug: string;
  name: string;
  count: number;
}

/**
 * Lists subjects that have at least one paper the public can see, for one
 * exam and year — this is the "pick a subject" step when browsing. A
 * subject with nothing recorded for that year simply doesn't show up,
 * instead of appearing as an empty, dead-end option.
 */
export const listPublicSubjectsForInstance = cache(async (
  seriesCode: string,
  year: number
): Promise<SubjectWithCount[]> => {
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
});

export interface DownloadableYearFile {
  fileId: string;
  storageKey: string;
  title: string;
}

/**
 * Gets every downloadable file for one exam and year, for the "download
 * all" zip feature. Only truly published papers are included here (unlike
 * the subject list above, a paper that's marked "not yet recovered" has no
 * actual file to include, so it's left out).
 */
export const listPublishedFilesForInstance = cache(async (
  seriesCode: string,
  year: number
): Promise<DownloadableYearFile[]> => {
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
});

/** Gets the most recently published exam papers, for the homepage's "Recently added" list. */
export const listRecentPublicArtifacts = cache(async (limit: number): Promise<PublicExamRecord[]> => {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT} where a.status = 'published' order by a.published_at desc limit $1`,
    [limit]
  );
  return rows.map(hydratePublicRecord);
});

export const getPublicArtifactBySlug = cache(async (
  seriesCode: string,
  year: number,
  subjectSlug: string,
  slug: string
): Promise<{ record: PublicExamRecord; related: PublicExamRecord[] } | undefined> => {
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
});

/**
 * Every publicly-visible paper for one exam series and subject, across all
 * years, listed oldest-first (the order a reader would naturally browse
 * through them). Used on a paper's detail page to build the "previous /
 * next" links and the "other years for this subject" list, all from one
 * query rather than checking each neighbouring year separately.
 */
export const listSubjectArtifacts = cache(async (
  seriesCode: string,
  subjectSlug: string
): Promise<PublicExamRecord[]> => {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT}
     where a.status in ${PUBLIC_STATUSES} and es.code = $1 and s.subject_code = $2
     order by ei.year asc, a.type asc, a.paper_no asc nulls first`,
    [seriesCode, subjectSlug]
  );
  return rows.map(hydratePublicRecord);
});

// --- Command-line tool: builds the "coverage matrix" — a grid showing,
// for every exam/year/subject combination, whether we have a published
// paper, a paper still waiting on rights approval, no paper at all, or a
// paper we know exists but haven't tracked down yet. -----------------------

export type CoverageStatus = "published" | "verified_pending_rights" | "missing" | "not_yet_recovered";

export interface CoverageCell {
  examSeriesCode: string;
  examSeriesName: string;
  year: number;
  subjectSlug: string;
  subjectName: string;
  // The collapsed, across-all-types status -- same semantics as before this
  // cell also tracked a `byType` breakdown, kept so a cell with only one
  // artifact type still has a single obvious status to check.
  status: CoverageStatus;
  // One entry per artifact type this subject has ever had ingested for it,
  // anywhere in the archive (e.g. "listening_comprehension" only appears
  // here for subjects that actually have listening papers, not every
  // subject) -- so a published question paper can no longer hide a missing
  // or not-yet-recovered marking scheme for the same cell.
  byType: Array<{ type: ArtifactType; status: CoverageStatus }>;
}

export async function getCoverageMatrix(): Promise<CoverageCell[]> {
  const realInstances = await query<{
    id: string;
    exam_series_id: string;
    year: number;
    series_code: string;
    series_name: string;
  }>(
    `select ei.id, ei.exam_series_id, ei.year, es.code as series_code, es.name as series_name
     from exam_instances ei
     join exam_series es on es.id = ei.exam_series_id
     order by es.name, ei.year`
  );

  const series = await query<{ id: string; code: string; name: string }>(
    "select id, code, name from exam_series order by name"
  );

  // exam_instances rows are only ever created at ingest time (see
  // ingestArtifact below) -- there's no upfront seeding of a full year
  // range. So a (series, year) that's never had anything ingested for it
  // has no exam_instances row at all, and would silently be missing from
  // this matrix entirely, rather than showing up as a fully-missing cell.
  // BROWSE_YEAR_FROM/BROWSE_YEAR_TO (see browse-years.ts) is already the
  // one canonical year range the rest of the site treats every series as
  // spanning, whether or not data exists yet for a given year -- reusing
  // it here fills in a synthetic instance for any (series, year) combo
  // that's missing a real row, with an id that can never match a real
  // artifact's exam_instance_id, so it naturally resolves to "missing"
  // for every type below, the same way an empty cell already does.
  const existingInstanceKeys = new Set(realInstances.map((i) => `${i.exam_series_id}:${i.year}`));
  const syntheticInstances = series.flatMap((s) =>
    listBrowseYears()
      .filter((year) => !existingInstanceKeys.has(`${s.id}:${year}`))
      .map((year) => ({
        id: `virtual:${s.id}:${year}`,
        exam_series_id: s.id,
        year,
        series_code: s.code,
        series_name: s.name,
      }))
  );

  const instances = [...realInstances, ...syntheticInstances].sort((a, b) =>
    a.series_name !== b.series_name ? a.series_name.localeCompare(b.series_name) : a.year - b.year
  );

  const subjects = await query<{ id: string; canonical_name: string; subject_code: string | null }>(
    "select id, canonical_name, subject_code from subjects order by canonical_name"
  );

  const artifacts = await query<{
    exam_instance_id: string;
    subject_id: string;
    type: ArtifactType;
    status: ArtifactStatus;
  }>("select exam_instance_id, subject_id, type, status from artifacts");

  // Every artifact type ever tracked for a given subject, across every
  // series/year -- this is what limits each cell's `byType` breakdown to
  // types that subject actually uses, instead of listing all six possible
  // types (most of which would just always read "Missing") for every cell.
  const typesBySubject = new Map<string, Set<ArtifactType>>();
  for (const a of artifacts) {
    const set = typesBySubject.get(a.subject_id) ?? new Set<ArtifactType>();
    set.add(a.type);
    typesBySubject.set(a.subject_id, set);
  }

  const statusesByCell = new Map<string, ArtifactStatus[]>();
  const statusesByCellAndType = new Map<string, Map<ArtifactType, ArtifactStatus[]>>();
  for (const a of artifacts) {
    const key = `${a.exam_instance_id}:${a.subject_id}`;

    const list = statusesByCell.get(key) ?? [];
    list.push(a.status);
    statusesByCell.set(key, list);

    const byType = statusesByCellAndType.get(key) ?? new Map<ArtifactType, ArtifactStatus[]>();
    const typeList = byType.get(a.type) ?? [];
    typeList.push(a.status);
    byType.set(a.type, typeList);
    statusesByCellAndType.set(key, byType);
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
      const byTypeStatuses = statusesByCellAndType.get(key);
      // Known limitation: this groups by `type` alone, not by `(type,
      // paper_no)` -- so if a type has more than one paper_no variant in
      // this cell (e.g. Industrial Arts' plain vs "cat" marking scheme,
      // Design Technology's woodmetal vs foodclothing streams) and those
      // variants ever end up with different statuses, deriveStatus below
      // merges them into one status rather than surfacing the split. Same
      // masking pattern as the collapsed-across-types bug this `byType`
      // field was added to fix, just one level finer. Checked against
      // live data when this was built: no cell currently has differing
      // statuses across paper_no variants, so nothing is misrepresented
      // today -- but worth knowing if a coverage cell ever looks wrong for
      // a subject with multiple paper_no variants of the same type.
      const byType = [...(typesBySubject.get(subject.id) ?? [])].map((type) => ({
        type,
        status: deriveStatus(byTypeStatuses?.get(type)),
      }));

      cells.push({
        examSeriesCode: instance.series_code,
        examSeriesName: instance.series_name,
        year: instance.year,
        subjectSlug: subject.subject_code ?? subject.id,
        subjectName: subject.canonical_name,
        status: deriveStatus(statusesByCell.get(key)),
        byType,
      });
    }
  }
  return cells;
}

// --- Command-line tool: adding a new exam paper into the archive -----------

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
 * Adds one exam paper file into the archive: fingerprints the file (so we
 * can detect duplicates later), saves it to storage, and creates its
 * database records. No matter what rights information is passed in here,
 * the paper always starts out marked "pending approval" — the person
 * running this command cannot mark a paper as rights-cleared themselves.
 * That has to happen separately, through `approveRights`, and only after
 * that can the paper actually be published. This split exists on purpose,
 * so a paper never becomes public before its usage rights are confirmed.
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

  // We save the file to storage BEFORE touching the database, and outside
  // the database transaction. That way, if saving the file fails, nothing
  // gets written to the database at all. The one downside: if the file
  // saves fine but the database step afterwards fails, we end up with a
  // "orphaned" file sitting in storage with no database record pointing
  // to it. That's an acceptable trade-off for now — a future version could
  // add a cleanup process to find and remove those leftover files.
  //
  // `createHash("sha256").update(bytes).digest("hex")` runs the file's raw
  // bytes through the SHA-256 hashing algorithm, producing a short, fixed-
  // length fingerprint of the file's exact contents (as a hex-digit
  // string). The same file always produces the same hash, and changing
  // even one byte produces a completely different one -- useful here for
  // detecting duplicate uploads and confirming a file hasn't been altered.
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

  // `withTransaction(async () => {...})` (see src/lib/db/client.ts) takes a
  // function containing every database change that has to succeed or fail
  // together as one unit -- if anything inside throws partway through,
  // every change made so far in this block is undone automatically.
  return withTransaction(async () => {
    // `let` (rather than `const`) is used for `examInstance` because it
    // might be reassigned a few lines down -- `const` variables can never
    // be assigned a new value after their first one. `randomUUID()`
    // generates a fresh, effectively-guaranteed-unique id string, used
    // throughout this file as the `id` for every new database row.
    // `!examInstance` reads as "if there is no exam instance yet" --
    // `undefined` (what queryOne returns when nothing matches) counts as
    // "false-like" here, the same way `!` worked on a real boolean earlier.
    let examInstance = await queryOne<{ id: string }>(
      "select id from exam_instances where exam_series_id = $1 and year = $2",
      [series.id, input.year]
    );
    if (!examInstance) {
      const id = randomUUID();
      // `insert into <table> (<columns>) values (<one $-placeholder per
      // column>)` is SQL's way of adding a brand-new row -- as opposed to
      // `select`, which only reads existing rows.
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

    // `{ title, sha256 }` is "shorthand property syntax": when a variable's
    // name already matches the object key you want, you can write just the
    // name once instead of `{ title: title, sha256: sha256 }`. The database
    // column this is going into only stores plain text, so `JSON.stringify`
    // converts the object into a text representation of it first (the
    // reverse of `JSON.parse`, mentioned in an earlier comment above).
    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_created', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ title, sha256 })]
    );

    return { artifactId, title, storageKey, sha256 };
  });
}

// --- Serving files for download — a direct PDF download must always work --

export interface DownloadableFile {
  storageKey: string;
  mime: string;
  bytes: number;
  title: string;
}

/**
 * Only hands back a file if its exam paper is CURRENTLY published. We
 * check this fresh against the database every single time (nothing is
 * cached here), so that if a paper gets withdrawn or put on hold, its file
 * stops being downloadable immediately — not after some delay.
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

// --- Handling reports from the public — corrections, takedown requests, etc. ---

export async function createIssue(input: {
  artifactId: string;
  issueType: string;
  description: string;
  contact: string | null;
}): Promise<void> {
  // We deliberately don't retry this save if it fails partway through.
  // There's nothing stopping the same report from being saved twice if we
  // retried, so it's safer to let it fail once than risk a duplicate.
  await queryWithoutRetry(
    `insert into issues (id, artifact_id, issue_type, description, contact, status)
     values ($1, $2, $3, $4, $5, 'open')`,
    [randomUUID(), input.artifactId, input.issueType, input.description, input.contact]
  );
}

// --- Command-line tool: listing exam papers, approving their rights
// status, and publishing/unpublishing them --------------------------------

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
 * Gets exam papers for one exam series within a range of years (both ends
 * included). This is what powers the command-line tool's bulk actions,
 * which let someone approve rights or publish a whole batch of papers at
 * once instead of one at a time.
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
 * Records the official decision that a paper's usage rights have been
 * cleared: who approved it, on what grounds, and the proof backing it up.
 * This is the only way those three details ever get filled in — when a
 * paper is first added, they're always left blank. And a paper can't be
 * published until all three are recorded here.
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
 * Checks whether a paper's rights approval is complete enough to publish.
 * Made available outside this file (not just used internally) so the
 * command-line tool's bulk-publish feature can check every candidate paper
 * in advance and report exactly which ones aren't ready yet, and why,
 * before actually publishing anything.
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
 * The only place in the whole app where a paper actually gets marked
 * "published". This does NOT approve the rights itself — it only checks
 * that `approveRights` has already been done (basis, approver, and
 * evidence all filled in), and refuses to publish otherwise, telling you
 * exactly what's still missing. Approving rights and publishing are kept
 * as two separate, deliberate steps on purpose, as a safety check.
 */
// `{ title: string } | { missing: string[] }` is a union (see
// src/types/domain.ts) of two entirely different object shapes: this
// function either succeeds and hands back a `title`, or fails and hands
// back what's `missing` -- never both, and never neither. Callers have to
// check which one they actually got (commonly with `"missing" in result`,
// as seen in scripts/cli.ts) before reading either field, which is exactly
// what makes this safer than, say, returning a title that's sometimes an
// empty string to mean failure.
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
 * Takes a published paper back down (e.g. withdrawing it, or putting it on
 * a rights hold) and records that this happened.
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
