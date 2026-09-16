import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";

/**
 * Reference/taxonomy scaffolding ONLY — exam series names, subject names,
 * and (series, year) slots that a coverage matrix needs to have something
 * to show gaps against (spec section 11.3, section 13.1 step 1). This is
 * NOT exam content: no artifacts, no files, no papers, no rights records.
 * Nothing here should be read as a confirmed historical record — the spec
 * itself flags the exact taxonomy as "subject to confirmation" (scope
 * baseline, section 0).
 *
 * The year range below (2018–2024) is a placeholder scaffold for local
 * development, not a confirmed curriculum year list. Real coverage-matrix
 * construction happens later per spec section 13.1.
 *
 * Called once by scripts/db-migrate.ts (npm run db:migrate) — not run on
 * every app/CLI startup the way the old sqlite version was, since
 * re-running the existence checks below on every serverless cold start
 * would be wasted work at best and a duplicate-key race at worst if two
 * cold starts both see an empty table. See migrations/README.md.
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
 * Minimal shape both `pg.Client` and `pg.PoolClient` satisfy — decoupled
 * from src/lib/db/client.ts's pool/transaction machinery so this can run
 * standalone from scripts/db-migrate.ts against the unpooled connection.
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
