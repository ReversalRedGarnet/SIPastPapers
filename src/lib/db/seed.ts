import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

/**
 * This only sets up basic reference data — the names of the exam series
 * and subjects, and empty "slots" for each (exam series, year) combination
 * so the coverage matrix has something to compare against. It does NOT add
 * any actual exam content: no papers, no files, no rights records.
 *
 * Nothing here should be treated as a confirmed, official record — this
 * list of exam series and subjects is still subject to being confirmed
 * later.
 *
 * The year range below (2018–2024) is just a placeholder set of years for
 * local development, not an official list of exam years.
 *
 * This only runs once, when someone runs `npm run db:migrate` — not every
 * time the app starts up. That's on purpose: running these checks on
 * every single app startup would be wasted effort at best, and could cause
 * a "duplicate data" error at worst if two startups happened at the same
 * moment and both saw an empty table.
 */

const EXAM_SERIES = [
  { code: "sif3-sijsc", name: "SIF3 / SIJSC", description: "Solomon Islands Form 3 / Junior Secondary Certificate." },
  { code: "sisc-l1", name: "SISC Level 1", description: "Solomon Islands School Certificate, Level 1." },
  { code: "sisc-l2-sinf6", name: "SISC Level 2 / SINF6", description: "Solomon Islands School Certificate, Level 2 / Form 6." },
];

const SUBJECTS = [
  { canonicalName: "Mathematics", subjectCode: "mathematics" },
  { canonicalName: "English", subjectCode: "english" },
  { canonicalName: "Science", subjectCode: "science" },
  { canonicalName: "Social Studies", subjectCode: "social-studies" },
];

const SCAFFOLD_YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024];

/**
 * Describes the minimum shape a database connection needs to have to be
 * used here — just something with a `query` method. This is kept separate
 * from the connection-pool logic in src/lib/db/client.ts so this file can
 * also be run on its own from the migration script, using a plain,
 * unpooled connection.
 */
export interface QueryRunner {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function seedReferenceData(db: QueryRunner): Promise<void> {
  const { rows: seriesCountRows } = await db.query<{ n: string }>("select count(*) as n from exam_series");
  const seriesCount = Number(seriesCountRows[0].n);

  let seriesIds: Record<string, string>;
  if (seriesCount === 0) {
    seriesIds = {};
    for (const s of EXAM_SERIES) {
      const id = randomUUID();
      await db.query("insert into exam_series (id, code, name, description) values ($1, $2, $3, $4)", [
        id,
        s.code,
        s.name,
        s.description,
      ]);
      seriesIds[s.code] = id;
    }
  } else {
    seriesIds = {};
    const { rows } = await db.query<{ id: string; code: string }>("select id, code from exam_series");
    for (const row of rows) {
      seriesIds[row.code] = row.id;
    }
  }

  const { rows: subjectCountRows } = await db.query<{ n: string }>("select count(*) as n from subjects");
  if (Number(subjectCountRows[0].n) === 0) {
    for (const s of SUBJECTS) {
      await db.query(
        "insert into subjects (id, canonical_name, aliases, subject_code) values ($1, $2, '[]', $3)",
        [randomUUID(), s.canonicalName, s.subjectCode]
      );
    }
  }

  const { rows: instanceCountRows } = await db.query<{ n: string }>("select count(*) as n from exam_instances");
  if (Number(instanceCountRows[0].n) === 0) {
    for (const seriesId of Object.values(seriesIds)) {
      for (const year of SCAFFOLD_YEARS) {
        await db.query(
          "insert into exam_instances (id, exam_series_id, year, official_name) values ($1, $2, $3, null)",
          [randomUUID(), seriesId, year]
        );
      }
    }
  }
}
