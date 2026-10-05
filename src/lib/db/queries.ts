import { randomUUID, createHash } from "node:crypto";
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { query, queryOne, queryWithoutRetry, withTransaction } from "./client";
import {
  APPROVED_RIGHTS_STATUSES,
  IS_CURRENT_FILE,
  OPENABLE,
  PUBLICLY_VISIBLE,
  QUARANTINE_PREFIX,
  SERVABLE,
  SUBJECT_SLUG,
} from "./visibility";
export { QUARANTINE_PREFIX } from "./visibility";
import { listBrowseYears } from "@/lib/browse-years";
import { getStorageProvider, StorageKeyExistsError, type StorageProvider } from "@/lib/storage";
import { buildStorageKey } from "@/lib/storage/types";
import {
  artifactSlug,
  artifactTypeSlug,
  generateArtifactTitle,
  generateCanonicalFileName,
} from "@/lib/artifact-naming";
import { pdfServingHeaders } from "@/lib/storage/serving-headers";
import { deleteYearZips } from "@/lib/year-zip";
import { parseSearchQuery } from "@/lib/search-query";
import { paperPath } from "@/lib/page-links";
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
  subject_slug: string;
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
  // `bytes` is a bigint column, which the pg driver returns as a string
  // (a bigint can be larger than a JavaScript number can hold exactly) --
  // converted with Number() below; PDFs are nowhere near that size.
  file_bytes: string | null;
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
    s.canonical_name as subject_name, ${SUBJECT_SLUG} as subject_slug
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
    s.canonical_name as subject_name, ${SUBJECT_SLUG} as subject_slug,
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
  -- is: a query nested inside another query. Only a published paper's
  -- file is shown: a "not yet recovered" placeholder that has somehow been
  -- given one still lists as a placeholder (and the file route won't serve
  -- it either -- see SERVABLE).
  left join lateral (
    select id, sha256, mime, bytes
    from files
    where artifact_id = a.id and a.status = 'published'
    order by created_at desc, id desc
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
    subjectSlug: row.subject_slug,
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
        ? { id: row.file_id, sha256: row.file_sha256!, mime: row.file_mime!, bytes: Number(row.file_bytes) }
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

// The visibility rules (approved rights, current file, quarantine, what's
// servable / publicly visible) live in ./visibility, shared with the proxy.

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
     where ${PUBLICLY_VISIBLE}`
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
 * two versions can never disagree about what a filter means. `visibleWhen`
 * is which papers may be listed at all: PUBLICLY_VISIBLE (placeholders
 * included) for the browse-subject page and the sitemap, OPENABLE for the
 * search results page.
 *
 * The keyword search (`q`) is done as a simple "contains this text"
 * database search. That's good enough for how much data this archive
 * currently has. A more advanced full-text search (which would rank
 * results by relevance and handle multi-word queries better) could be
 * added later, but isn't needed yet.
 */
function buildPublicArtifactFilterClauses(
  filters: PublicArtifactFilters,
  visibleWhen: string
): {
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
  const clauses: string[] = [visibleWhen];
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
    clauses.push(`${SUBJECT_SLUG} = $${params.length}`);
  }
  // `?.` ("optional chaining") means "only call .trim() if filters.q
  // actually has a value; if it's missing, just skip straight to
  // `undefined` instead of crashing by trying to call .trim() on nothing."
  const q = filters.q?.trim();
  if (q) {
    // The search box text, split into a year filter, an exam-series filter
    // and words that must each match -- see src/lib/search-query.ts.
    const search = parseSearchQuery(q);
    if (search.years.length > 0) {
      params.push(search.years.join(","));
      clauses.push(`ei.year = any(string_to_array($${params.length}, ',')::int[])`);
    }
    if (search.seriesCodes.length > 0) {
      params.push(search.seriesCodes.join(","));
      clauses.push(`es.code = any(string_to_array($${params.length}, ','))`);
    }
    for (const group of search.termGroups) {
      // Each word (or one of its short forms) must appear somewhere. The
      // words only ever contain letters, digits, spaces and "&", so they
      // can't carry LIKE wildcards.
      const alternatives = group.map((term) => {
        params.push(`%${term}%`);
        const p = `$${params.length}`;
        return `a.title ilike ${p} or s.canonical_name ilike ${p} or es.name ilike ${p}
          or exists (select 1 from jsonb_array_elements_text(s.aliases) alias where alias ilike ${p})`;
      });
      clauses.push(`(${alternatives.join(" or ")})`);
    }
  }

  return { clauses, params };
}

/**
 * Results order: newest year first, then subject, then a fixed order
 * within a subject (type, paper number, id) -- so every page of results
 * lists papers in the same order and none repeat or go missing between
 * pages.
 */
const PUBLIC_RESULTS_ORDER = "order by ei.year desc, s.canonical_name, a.type, a.paper_no nulls first, a.id";

/**
 * Every matching paper the public can see, "not yet recovered" placeholders
 * included -- for the browse-subject page and the sitemap (which itself
 * keeps only papers with a file). The search results page uses
 * searchPublicArtifactsPage below, which lists only papers that can be opened.
 */
export const searchPublicArtifacts = cache(async (filters: PublicArtifactFilters): Promise<PublicExamRecord[]> => {
  const { clauses, params } = buildPublicArtifactFilterClauses(filters, PUBLICLY_VISIBLE);
  const sql = `${PUBLIC_ARTIFACT_SELECT} where ${clauses.join(" and ")} ${PUBLIC_RESULTS_ORDER}`;
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
 * Unlike the search above, it lists only papers a student can open
 * (OPENABLE): published, with a file, and rights currently approved. A
 * "not yet recovered" placeholder is never in a page of results or in the
 * count -- search mustn't offer what can't be opened; browse and /missing
 * are where the gaps are shown.
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

  const { clauses, params } = buildPublicArtifactFilterClauses(filters, OPENABLE);
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
      `${PUBLIC_ARTIFACT_SELECT} where ${where} ${PUBLIC_RESULTS_ORDER} limit $${dataParams.length - 1} offset $${dataParams.length}`,
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
  const rows = await query<{ slug: string; name: string; count: string }>(
    `select ${SUBJECT_SLUG} as slug, s.canonical_name as name, count(*) as count
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join subjects s on s.id = a.subject_id
     where es.code = $1 and ei.year = $2 and ${PUBLICLY_VISIBLE}
     group by s.id
     order by s.canonical_name`,
    [seriesCode, year]
  );
  return rows.map((r) => ({ slug: r.slug, name: r.name, count: Number(r.count) }));
});

export interface DownloadableYearFile {
  fileId: string;
  storageKey: string;
  title: string;
  /** The file's recorded fingerprint -- part of what names a year's prebuilt zip (src/lib/year-zip.ts). */
  sha256: string;
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
  const rows = await query<{ file_id: string; storage_key: string; title: string; sha256: string }>(
    `select f.id as file_id, f.storage_key, a.title, f.sha256
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join files f on f.artifact_id = a.id
     where es.code = $1 and ei.year = $2 and ${SERVABLE} and ${IS_CURRENT_FILE}
     order by a.title`,
    [seriesCode, year]
  );
  return rows.map((r) => ({ fileId: r.file_id, storageKey: r.storage_key, title: r.title, sha256: r.sha256 }));
});

/**
 * Every exam series + year with at least one servable file -- the years
 * that should have a prebuilt zip (see build-zips in scripts/cli.ts).
 */
export async function listServableYearInstances(): Promise<{ seriesCode: string; year: number }[]> {
  const rows = await query<{ code: string; year: number }>(
    `select distinct es.code, ei.year
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join files f on f.artifact_id = a.id
     where ${SERVABLE} and ${IS_CURRENT_FILE}
     order by es.code, ei.year`
  );
  return rows.map((r) => ({ seriesCode: r.code, year: r.year }));
}

/** The exam series + year a paper belongs to (whatever its status), or undefined for an unknown id. */
export async function getArtifactInstance(artifactId: string): Promise<{ seriesCode: string; year: number } | undefined> {
  const row = await queryOne<{ code: string; year: number }>(
    `select es.code, ei.year
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     where a.id = $1`,
    [artifactId]
  );
  return row && { seriesCode: row.code, year: row.year };
}

/** Gets the most recently published exam papers, for the homepage's "Recently added" list. */
export const listRecentPublicArtifacts = cache(async (limit: number): Promise<PublicExamRecord[]> => {
  const rows = await query<PublicArtifactRow>(
    `${PUBLIC_ARTIFACT_SELECT} where ${SERVABLE} order by a.published_at desc limit $1`,
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
     where ${PUBLICLY_VISIBLE} and es.code = $1 and ei.year = $2 and ${SUBJECT_SLUG} = $3`,
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
     where ${PUBLICLY_VISIBLE} and es.code = $1 and ${SUBJECT_SLUG} = $2
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

function duplicateArtifactError(existingId: string): Error {
  return new Error(
    `An artifact already exists for this exam / subject / type / paper number (id ${existingId}). Edit the existing record instead of creating a duplicate.`
  );
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Saves a newly ingested file to storage, never replacing anything that's
 * already there (storage itself refuses -- see StorageKeyExistsError).
 *
 * The one case that's allowed through: the exact same bytes (same SHA-256)
 * are already stored at this key. ingestArtifact has already confirmed no
 * artifact uses this key, so that can only be a leftover from an earlier
 * ingest of this same file that uploaded it and then failed before the
 * database records were written. Reusing it is safe, and means simply
 * re-running the ingest fixes things. Different bytes are refused.
 */
async function putWithoutOverwriting(
  storageKey: string,
  file: { buffer: Buffer; mime: string },
  sha256: string,
  title: string
) {
  const storage = getStorageProvider();
  try {
    // The headers R2 sends when the file is served straight from it: shown
    // in the browser ("inline"), named after the paper's title, and kept by
    // the visitor's browser for 10 minutes (see serving-headers.ts).
    await storage.put(storageKey, file.buffer, { ...pdfServingHeaders(title), contentType: file.mime });
  } catch (err) {
    if (!(err instanceof StorageKeyExistsError)) throw err;
    const existing = await storage.get(storageKey);
    if (!existing || sha256Hex(existing) !== sha256) {
      throw new Error(
        `Storage already holds a different file at "${storageKey}", with no artifact record pointing to it ` +
          `(probably left over from an earlier ingest that failed partway). Refusing to overwrite it — ` +
          `check that stored file by hand before removing it.`
      );
    }
  }
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

  // The order of the steps below matters:
  //   1. Refuse a duplicate artifact BEFORE touching storage. Storage keys
  //      are built from the paper's details, so a duplicate would map to
  //      the very same key as the paper already in the archive -- checking
  //      only after saving used to silently replace a published paper's
  //      file, and then fail.
  //   2. Save the file, outside the database transaction, never replacing
  //      anything (see putWithoutOverwriting). If saving fails, nothing
  //      gets written to the database at all.
  //   3. Write the database records in one transaction, checking for a
  //      duplicate once more in case one appeared in the meantime.
  // If step 3 fails after step 2 worked, the file is left in storage with
  // no record pointing to it; re-running the same ingest reuses it.
  //
  // `createHash("sha256").update(bytes).digest("hex")` runs the file's raw
  // bytes through the SHA-256 hashing algorithm, producing a short, fixed-
  // length fingerprint of the file's exact contents (as a hex-digit
  // string). The same file always produces the same hash, and changing
  // even one byte produces a completely different one -- useful here for
  // detecting duplicate uploads and confirming a file hasn't been altered.
  const sha256 = sha256Hex(input.file.buffer);
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

  const existing = await queryOne<{ id: string }>(
    `select a.id from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     where ei.exam_series_id = $1 and ei.year = $2 and a.subject_id = $3 and a.type = $4
       and ((a.paper_no is null and $5::text is null) or a.paper_no = $5::text)`,
    [series.id, input.year, subject.id, input.artifactType, input.paperNo]
  );
  if (existing) throw duplicateArtifactError(existing.id);

  await putWithoutOverwriting(storageKey, input.file, sha256, title);

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
    if (duplicate) throw duplicateArtifactError(duplicate.id);

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
 * Only hands back a file if its exam paper is CURRENTLY published with
 * rights currently approved (see SERVABLE), and it's the paper's current
 * file (see IS_CURRENT_FILE). We check this fresh against the database
 * every single time (nothing is cached here), so that if a paper gets
 * withdrawn, put on hold, or its rights lapse, /api/files stops handing
 * out links to it immediately. (A link handed out just before stays valid
 * until it expires -- see PRESIGNED_LINK_SECONDS.)
 */
export async function getFileForDownload(fileId: string): Promise<DownloadableFile | undefined> {
  const row = await queryOne<{
    storage_key: string;
    mime: string;
    bytes: string;
    title: string;
  }>(
    `select f.storage_key, f.mime, f.bytes, a.title
     from files f
     join artifacts a on a.id = f.artifact_id
     where f.id = $1 and ${SERVABLE} and ${IS_CURRENT_FILE}`,
    [fileId]
  );

  if (!row) return undefined;
  return { storageKey: row.storage_key, mime: row.mime, bytes: Number(row.bytes), title: row.title };
}

// --- Handling reports from the public — corrections, takedown requests, etc. ---

/**
 * The public page address of a paper (e.g.
 * "/exams/sisc-l1/2019/mathematics/paper-1"), or undefined if there's no
 * such paper or it isn't public. Used by the report form to confirm a
 * report is about a real, public paper, and to send the visitor back to it.
 */
export async function getPublicArtifactPath(artifactId: string): Promise<string | undefined> {
  const row = await queryOne<{ type: ArtifactType; paper_no: string | null; year: number; series_code: string; subject_slug: string }>(
    `select a.type, a.paper_no, ei.year, es.code as series_code, ${SUBJECT_SLUG} as subject_slug
     from artifacts a
     join exam_instances ei on ei.id = a.exam_instance_id
     join exam_series es on es.id = ei.exam_series_id
     join subjects s on s.id = a.subject_id
     where a.id = $1 and ${PUBLICLY_VISIBLE}`,
    [artifactId]
  );
  if (!row) return undefined;
  const slug = artifactSlug({ artifactType: row.type, paperNo: row.paper_no });
  return paperPath({ examSeriesCode: row.series_code, year: row.year, subjectSlug: row.subject_slug, slug });
}

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

export interface StoredFile {
  fileId: string;
  storageKey: string;
  title: string;
  status: ArtifactStatus;
}

/**
 * Every file record with its paper's title and status, regardless of
 * whether the paper is public -- for the CLI's storage maintenance
 * commands (e.g. set-disposition), never for public pages.
 */
export async function listStoredFiles(): Promise<StoredFile[]> {
  const rows = await query<{ file_id: string; storage_key: string; title: string; status: ArtifactStatus }>(
    `select f.id as file_id, f.storage_key, a.title, a.status
     from files f
     join artifacts a on a.id = f.artifact_id
     order by f.storage_key`
  );
  return rows.map((r) => ({ fileId: r.file_id, storageKey: r.storage_key, title: r.title, status: r.status }));
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

export interface RightsExpiryEntry {
  artifactId: string;
  title: string;
  /** "YYYY-MM-DD" */
  expiry: string;
  /** Days from today until the expiry date: 0 = expires today (still valid), negative = already expired. */
  daysLeft: number;
}

/**
 * Published papers whose rights expire within `days` days, plus any whose
 * expiry date has already passed -- those are now hidden from the public
 * site (see RIGHTS_CURRENTLY_APPROVED) even though still "published".
 * Soonest first. For the CLI's rights-expiring command.
 */
export async function listPublishedRightsExpiring(days: number): Promise<RightsExpiryEntry[]> {
  const rows = await query<{ id: string; title: string; expiry: string; days_left: number }>(
    // Subtracting one date from another in Postgres gives a whole number of
    // days; `$1::int` makes `current_date + $1` mean "that many days ahead".
    `select a.id, a.title,
            to_char(latest.expiry_date, 'YYYY-MM-DD') as expiry,
            latest.expiry_date - current_date as days_left
     from artifacts a
     join lateral (
       select rr.expiry_date
       from rights_records rr
       where rr.artifact_id = a.id
       order by rr.created_at desc
       limit 1
     ) latest on true
     where a.status = 'published'
       and latest.expiry_date is not null
       and latest.expiry_date <= current_date + $1::int
     order by latest.expiry_date, a.title`,
    [days]
  );
  return rows.map((r) => ({ artifactId: r.id, title: r.title, expiry: r.expiry, daysLeft: r.days_left }));
}

/**
 * Published papers whose most recent rights record doesn't have an
 * approved status (e.g. it was set to rights_hold or denied after
 * publishing) -- also hidden from the public site despite being
 * "published". For the CLI's rights-expiring command.
 */
export async function listPublishedWithUnapprovedRights(): Promise<
  { artifactId: string; title: string; rightsStatus: RightsStatus | null }[]
> {
  const rows = await query<{ id: string; title: string; rights_status: RightsStatus | null }>(
    `select a.id, a.title, latest.rights_status
     from artifacts a
     left join lateral (
       select rr.rights_status
       from rights_records rr
       where rr.artifact_id = a.id
       order by rr.created_at desc
       limit 1
     ) latest on true
     where a.status = 'published'
       and (latest.rights_status is null
            or latest.rights_status not in (${APPROVED_RIGHTS_STATUSES.map((s) => `'${s}'`).join(", ")}))
     order by a.title`
  );
  return rows.map((r) => ({ artifactId: r.id, title: r.title, rightsStatus: r.rights_status }));
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
  const rights = await queryOne<{
    basis: string | null;
    approved_by: string | null;
    evidence_uri: string | null;
    rights_status: RightsStatus;
    expiry: string | null;
    expired: boolean;
  }>(
    // `to_char(...)` turns the date into plain "YYYY-MM-DD" text for the
    // message below; `expiry_date < current_date` lets the database decide
    // whether it has passed, using its own idea of "today".
    `select basis, approved_by, evidence_uri, rights_status,
            to_char(expiry_date, 'YYYY-MM-DD') as expiry,
            coalesce(expiry_date < current_date, false) as expired
     from rights_records where artifact_id = $1 order by created_at desc limit 1`,
    [artifactId]
  );

  const missing: string[] = [];
  if (!rights) {
    return { satisfied: false, missing: ["basis", "approved_by", "evidence_uri (no rights record at all)"] };
  }
  if (!rights.basis) missing.push("basis");
  if (!rights.approved_by) missing.push("approved_by");
  if (!rights.evidence_uri) missing.push("evidence_uri");
  // Each entry reads as "what's still needed", since that's how the CLI
  // shows this list ("Cannot publish ... still needs: ...").
  if (!APPROVED_RIGHTS_STATUSES.includes(rights.rights_status)) {
    missing.push(`an approved rights_status (currently "${rights.rights_status}")`);
  }
  if (rights.expired) missing.push(`unexpired rights (expired ${rights.expiry})`);
  return { satisfied: missing.length === 0, missing };
}

/**
 * The only place in the whole app where a paper actually gets marked
 * "published". This does NOT approve the rights itself — it only checks
 * that `approveRights` has already been done (basis, approver, and
 * evidence all filled in, an approved rights status, not expired -- see
 * checkRightsGate), and refuses to publish otherwise, telling you
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
//
// A paper published again after `unpublish` first has its file(s) moved
// back from quarantine to their original key (filesRestored), so it's
// never served from a quarantine key. If that can't be done, it isn't
// published.
export async function publishArtifact(
  artifactId: string
): Promise<{ title: string; filesRestored: number } | { missing: string[] }> {
  const current = await queryOne<{ status: ArtifactStatus }>("select status from artifacts where id = $1", [
    artifactId,
  ]);
  if (!current) throw new Error(`Unknown artifact: ${artifactId}`);
  // Checked here as well as below so a paper that can't be published
  // anyway is refused before any stored file is moved.
  if (current.status !== "published") {
    const gate = await checkRightsGate(artifactId);
    if (!gate.satisfied) return { missing: gate.missing };
  }

  const restore = await restoreQuarantinedFiles(artifactId);
  if (restore.errors.length > 0) {
    return { missing: restore.errors.map((e) => `its stored file back at its original key (${e})`) };
  }

  // The rights check and the status change happen inside one transaction,
  // so the check can't go stale between being made and acted on.
  return withTransaction(async () => {
    // `for update` locks this paper's row until the transaction finishes,
    // so nothing else can change its status in the meantime.
    const artifact = await queryOne<{ id: string; title: string; status: ArtifactStatus }>(
      "select id, title, status from artifacts where id = $1 for update",
      [artifactId]
    );
    if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
    if (artifact.status === "published") return { title: artifact.title, filesRestored: restore.restored };

    const gate = await checkRightsGate(artifactId);
    if (!gate.satisfied) return { missing: gate.missing };

    // Never publish a paper whose current file isn't actually stored where
    // its record says (e.g. purged), or is still in quarantine.
    const file = await queryOne<{ storage_key: string }>(
      "select storage_key from files where artifact_id = $1 order by created_at desc, id desc limit 1",
      [artifactId]
    );
    if (!file) return { missing: ["a stored file (none is recorded)"] };
    if (file.storage_key.startsWith(QUARANTINE_PREFIX)) {
      return { missing: [`its stored file out of quarantine (still at ${file.storage_key})`] };
    }
    if (!(await getStorageProvider().exists(file.storage_key))) {
      return { missing: [`its stored file (nothing is stored at ${file.storage_key})`] };
    }

    const now = new Date().toISOString();
    await query("update artifacts set status = 'published', published_at = $1 where id = $2", [
      now,
      artifactId,
    ]);

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_published', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ filesRestored: restore.restored })]
    );

    return { title: artifact.title, filesRestored: restore.restored };
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
): Promise<{ title: string; zipsDeleted: number } & QuarantineResult> {
  const artifact = await queryOne<{ id: string; title: string; status: ArtifactStatus }>(
    "select id, title, status from artifacts where id = $1",
    [artifactId]
  );
  if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
  if (artifact.status !== "published") {
    throw new Error(`Artifact ${artifactId} is not published (status: ${artifact.status}).`);
  }

  await withTransaction(async () => {
    await query("update artifacts set status = $1 where id = $2", [toStatus, artifactId]);

    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, 'artifact_unpublished', 'artifact', $2, $3)`,
      [randomUUID(), artifactId, JSON.stringify({ toStatus, reason: reason ?? null })]
    );
  });

  // From here on the site already refuses to hand the paper out. Moving
  // its stored file(s) also cuts off any download link handed out in the
  // last few minutes, which would otherwise keep working until it expired.
  const quarantine = await quarantineArtifactFiles(artifactId);

  // The same for its year's zip: every stored zip of that year may include
  // this paper, so they're all deleted (rebuild with `build-zips`; until
  // then the year's "Download all" says it isn't ready yet).
  let zipsDeleted = 0;
  const instance = await getArtifactInstance(artifactId);
  if (instance) {
    try {
      zipsDeleted = (await deleteYearZips(getStorageProvider(), instance.seriesCode, instance.year)).length;
    } catch (err) {
      quarantine.moveErrors.push(
        `${instance.seriesCode} ${instance.year} year zip: couldn't delete it: ${errorText(err)}`
      );
    }
  }
  return { title: artifact.title, ...quarantine, zipsDeleted };
}

export interface QuarantineResult {
  /** How many stored files were moved to a quarantine key. */
  filesMoved: number;
  /**
   * One message per file that couldn't be fully moved (the paper is
   * unpublished regardless). Either way the file record still points at a
   * key that exists; links to the old key keep working until they expire.
   */
  moveErrors: string[];
}

/**
 * The key a file is moved to when its paper is unpublished:
 * "quarantine/<UTC timestamp>/<original key>". The timestamp makes every
 * unpublish use a fresh key, so a file is never refused for its
 * quarantine key already being taken by an earlier unpublish.
 */
export function quarantineKeyFor(storageKey: string, now: Date = new Date()): string {
  // e.g. "2026-10-01T11:53:59.123Z" -> "20261001T115359"
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `${QUARANTINE_PREFIX}${stamp}/${originalKeyFor(storageKey)}`;
}

/** The key a quarantined file came from (and goes back to if its paper is published again). Any other key is returned unchanged. */
export function originalKeyFor(storageKey: string): string {
  return storageKey.startsWith(QUARANTINE_PREFIX) ? storageKey.replace(/^quarantine\/[^/]+\//, "") : storageKey;
}

/** One stored file being moved to a new key -- see relocateStoredFile. */
export interface FileRelocation {
  fileId: string;
  artifactId: string;
  fromKey: string;
  toKey: string;
  /** The fingerprint recorded for the file, to recognise an identical copy already at `toKey`. */
  sha256: string;
  /** What audit_events records the move as. */
  eventType: "file_quarantined" | "file_restored";
}

export type RelocationOutcome =
  /** The file record now points at `toKey`. `leftoverKey`: the old copy, if it couldn't be deleted. */
  | { moved: true; leftoverKey: string | null; note?: string }
  /** The file record still points at a key that exists (`fromKey`, unless the error says otherwise). */
  | { moved: false; error: string };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Points a file record at its new key and logs it -- only if the record still points at the old key. */
async function recordFileRelocation(move: FileRelocation): Promise<void> {
  await withTransaction(async () => {
    const updated = await query(
      "update files set storage_key = $1 where id = $2 and storage_key = $3 returning id",
      [move.toKey, move.fileId, move.fromKey]
    );
    if (updated.length !== 1) throw new Error(`file ${move.fileId} no longer points at ${move.fromKey}`);
    await query(
      `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
       values ($1, null, $2, 'artifact', $3, $4)`,
      [
        randomUUID(),
        move.eventType,
        move.artifactId,
        JSON.stringify({ fileId: move.fileId, from: move.fromKey, to: move.toKey }),
      ]
    );
  });
}

/**
 * Moves one stored file to a new key and points its file record there, in
 * an order that keeps the record pointing at a key that exists at every
 * moment -- even if the process dies part-way:
 *   1. copy the file to the new key (the old copy is untouched);
 *   2. repoint the record (only if it still points at the old key) and log
 *      it, in one transaction;
 *   3. only then delete the old copy.
 * If step 2 fails, the record is read back to see which key it holds: still
 * the old one -> the new copy is removed again, as if nothing happened; the
 * new one (the commit went through after all) -> carry on with step 3;
 * can't tell -> both copies are left in place, which is always safe. If
 * step 3 fails, the record already points at the new key and the old copy
 * is reported as left over.
 *
 * Running it again after a failure is safe: an identical copy (same
 * sha256) already at the new key is used as-is.
 *
 * `recordMove` is step 2; only tests pass anything else, to make it fail.
 */
export async function relocateStoredFile(
  storage: StorageProvider,
  move: FileRelocation,
  recordMove: (move: FileRelocation) => Promise<void> = recordFileRelocation
): Promise<RelocationOutcome> {
  let createdCopy = true;
  try {
    await storage.copy(move.fromKey, move.toKey);
  } catch (err) {
    if (!(err instanceof StorageKeyExistsError)) {
      return { moved: false, error: `copying it to ${move.toKey} failed: ${errorText(err)}` };
    }
    const existing = await storage.get(move.toKey);
    if (!existing || sha256Hex(existing) !== move.sha256) {
      return { moved: false, error: `a different file is already stored at ${move.toKey}` };
    }
    createdCopy = false; // left by an earlier attempt -- same bytes, so use it
  }

  try {
    await recordMove(move);
  } catch (err) {
    const recordedKey = await queryOne<{ storage_key: string }>("select storage_key from files where id = $1", [
      move.fileId,
    ])
      .then((row) => row?.storage_key)
      .catch(() => undefined);
    if (recordedKey !== move.toKey) {
      if (recordedKey === move.fromKey && createdCopy) await storage.delete(move.toKey).catch(() => {});
      return {
        moved: false,
        error:
          `updating its file record failed (${errorText(err)}); the record still points at ` +
          (recordedKey ?? `an unknown key -- check files.id ${move.fileId}`),
      };
    }
  }

  try {
    await storage.delete(move.fromKey);
  } catch (err) {
    return { moved: true, leftoverKey: move.fromKey, note: `the old copy couldn't be deleted: ${errorText(err)}` };
  }
  return { moved: true, leftoverKey: null };
}

/**
 * Moves every stored file of an (already unpublished) paper that isn't
 * already there to a quarantine key, and points its file records there.
 * Download links are tied to a file's key, so this makes every link
 * already handed out stop working immediately -- the "instant revoke".
 * Nothing is deleted (see purgeArtifactFiles for that): the bytes are kept,
 * each move is logged in audit_events, and publishing the paper again moves
 * them back to their original keys.
 */
async function quarantineArtifactFiles(artifactId: string): Promise<QuarantineResult> {
  const storage = getStorageProvider();
  const files = await query<{ id: string; storage_key: string; sha256: string }>(
    "select id, storage_key, sha256 from files where artifact_id = $1 and not starts_with(storage_key, $2)",
    [artifactId, QUARANTINE_PREFIX]
  );
  let filesMoved = 0;
  const moveErrors: string[] = [];
  for (const file of files) {
    const outcome = await relocateStoredFile(storage, {
      fileId: file.id,
      artifactId,
      fromKey: file.storage_key,
      toKey: quarantineKeyFor(file.storage_key),
      sha256: file.sha256,
      eventType: "file_quarantined",
    });
    if (!outcome.moved) {
      moveErrors.push(`${file.storage_key}: ${outcome.error}`);
      continue;
    }
    filesMoved++;
    if (outcome.leftoverKey) moveErrors.push(`${file.storage_key}: quarantined, but ${outcome.note}`);
  }
  return { filesMoved, moveErrors };
}

/**
 * Moves a paper's quarantined files back to their original keys -- the
 * first step of publishing it again (see publishArtifact). A quarantine
 * copy that can't be deleted afterwards is harmless (nothing points at it,
 * and nothing under quarantine/ is ever served), so only failures to move
 * a file back count as errors.
 */
async function restoreQuarantinedFiles(artifactId: string): Promise<{ restored: number; errors: string[] }> {
  const files = await query<{ id: string; storage_key: string; sha256: string }>(
    "select id, storage_key, sha256 from files where artifact_id = $1 and starts_with(storage_key, $2)",
    [artifactId, QUARANTINE_PREFIX]
  );
  if (files.length === 0) return { restored: 0, errors: [] };

  const storage = getStorageProvider();
  let restored = 0;
  const errors: string[] = [];
  for (const file of files) {
    const outcome = await relocateStoredFile(storage, {
      fileId: file.id,
      artifactId,
      fromKey: file.storage_key,
      toKey: originalKeyFor(file.storage_key),
      sha256: file.sha256,
      eventType: "file_restored",
    });
    if (outcome.moved) restored++;
    else errors.push(`${file.storage_key}: ${outcome.error}`);
  }
  return { restored, errors };
}

/** A paper's status, or undefined if there's no such paper. */
export async function getArtifactStatus(artifactId: string): Promise<ArtifactStatus | undefined> {
  const row = await queryOne<{ status: ArtifactStatus }>("select status from artifacts where id = $1", [artifactId]);
  return row?.status;
}

export interface PurgeCandidate {
  fileId: string;
  storageKey: string;
  bytes: number;
}

/**
 * The first half of `unpublish --purge`, for a paper that's already
 * unpublished (unpublishArtifact does this itself for a published one):
 * quarantines any of its files that aren't yet, and lists every
 * quarantined file -- what purgeArtifactFiles would permanently delete.
 */
export async function prepareArtifactPurge(
  artifactId: string
): Promise<{ title: string; quarantine: QuarantineResult; files: PurgeCandidate[] }> {
  const artifact = await queryOne<{ title: string; status: ArtifactStatus }>(
    "select title, status from artifacts where id = $1",
    [artifactId]
  );
  if (!artifact) throw new Error(`Unknown artifact: ${artifactId}`);
  if (artifact.status === "published") {
    throw new Error(`Artifact ${artifactId} is published -- unpublish it before purging its files.`);
  }
  const quarantine = await quarantineArtifactFiles(artifactId);
  const files = await query<{ id: string; storage_key: string; bytes: string }>(
    `select id, storage_key, bytes from files
     where artifact_id = $1 and starts_with(storage_key, $2) order by storage_key`,
    [artifactId, QUARANTINE_PREFIX]
  );
  return {
    title: artifact.title,
    quarantine,
    files: files.map((f) => ({ fileId: f.id, storageKey: f.storage_key, bytes: Number(f.bytes) })),
  };
}

/**
 * Permanently deletes an unpublished paper's quarantined files -- the
 * second half of `unpublish --purge --confirm`. Each file is deleted from
 * storage, its file record removed and a `file_purged` audit event
 * (keeping its key, sha256, size and type) written, with the paper's row
 * locked so it can't be published again part-way. Only quarantined files
 * of a paper that isn't published are ever touched. Once purged, the paper
 * can't be published again (it has no file) unless re-ingested.
 */
export async function purgeArtifactFiles(
  artifactId: string,
  reason: string | null = null
): Promise<{ purged: PurgeCandidate[]; errors: string[] }> {
  const storage = getStorageProvider();
  const candidates = await query<{ id: string }>(
    "select id from files where artifact_id = $1 and starts_with(storage_key, $2) order by storage_key",
    [artifactId, QUARANTINE_PREFIX]
  );
  const purged: PurgeCandidate[] = [];
  const errors: string[] = [];
  for (const { id } of candidates) {
    try {
      const done = await withTransaction(async () => {
        const artifact = await queryOne<{ status: ArtifactStatus }>(
          "select status from artifacts where id = $1 for update",
          [artifactId]
        );
        if (artifact?.status === "published") throw new Error("the paper has been published again");
        const file = await queryOne<{ storage_key: string; sha256: string; mime: string; bytes: string }>(
          "select storage_key, sha256, mime, bytes from files where id = $1 for update",
          [id]
        );
        if (!file || !file.storage_key.startsWith(QUARANTINE_PREFIX)) return null; // moved since -- leave it
        await storage.delete(file.storage_key);
        await query("delete from files where id = $1", [id]);
        await query(
          `insert into audit_events (id, actor_id, event_type, object_type, object_id, metadata)
           values ($1, null, 'file_purged', 'artifact', $2, $3)`,
          [
            randomUUID(),
            artifactId,
            JSON.stringify({
              fileId: id,
              key: file.storage_key,
              sha256: file.sha256,
              mime: file.mime,
              bytes: Number(file.bytes),
              reason,
            }),
          ]
        );
        return { fileId: id, storageKey: file.storage_key, bytes: Number(file.bytes) };
      });
      if (done) purged.push(done);
    } catch (err) {
      errors.push(`file ${id}: ${errorText(err)}`);
    }
  }
  return { purged, errors };
}
