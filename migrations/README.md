# Migrations

Plain, numbered SQL files implementing the schema in `PROJECT_SPEC.md`
section 4.2: `exam_series`, `exam_instances`, `subjects`, `artifacts`,
`files`, `sources`, `artifact_sources`, `verifications`, `rights_records`,
`issues`, `audit_events`.

## Postgres only

There is a single schema here (`0001_init.sql`) applied to a real Postgres
database (Neon) — there is no local/offline SQLite variant any more. An
earlier phase ran on `node:sqlite` because no Postgres instance was
available yet; that code path (`migrations/sqlite/`,
`src/lib/db/migrate.ts`) has been removed now that real Neon credentials
exist (see PROJECT_SPEC.md decision log, 2026-09-13). Local development now
requires a live Postgres connection — see the root README for why a
dual-mode wasn't practical.

## Applying a migration

Migrations are **not** applied automatically by the app at request/cold-start
time — running arbitrary DDL from inside a serverless function on every
invocation is unsafe (concurrent runs, no operator visibility). Instead, run
them explicitly with:

```sh
npm run db:migrate
```

This connects with the **unpooled** `DATABASE_URL` (not
`DATABASE_URL_POOLED` — DDL and the advisory-lock-free tracking table used
here don't need pooling, and Neon recommends the direct connection for
migrations), applies any `migrations/*.sql` file not yet recorded in the
`_migrations` tracking table (in filename order), and then seeds reference
data (`src/lib/db/seed.ts`) — exam series, subjects, and the scaffold
(series, year) instances the coverage matrix needs to show gaps against.
Both steps are idempotent: re-running `npm run db:migrate` after adding a
new `NNNN_*.sql` file only applies what's new, and seeding only inserts rows
that don't already exist.

Run this once against a fresh Neon database before running the app, the
CLI, or the test suite (the test suite assumes the reference data seeded
here already exists — see `src/lib/db/queries.test.ts`).

Never hand-edit a production table as a substitute for a new migration file
(spec section 23).

## Before merging a PR that adds a migration

Vercel auto-deploys `main` on merge, but nothing here ties that deploy to
whether a new migration has actually been applied to production yet.
Before merging any PR that adds a new `migrations/*.sql` file, run `npm run
db:migrate` against the production `DATABASE_URL` first, so the schema
change lands before the code that depends on it deploys — not after.

## Notes

- Controlled vocabularies (valid values for `type`, `status`,
  `rights_status`, etc.) are intentionally left undefined at the database
  level per spec section 4.3 — enforce them in the application/validation
  layer for now so vocabulary changes don't require a schema migration.
- Foreign keys use `ON DELETE RESTRICT` throughout: destructive deletes
  should go through an explicit, logged application workflow rather than
  cascading automatically (spec section 23: "every destructive or
  rights-sensitive action must be reversible or logged").
- `rights_records.created_at` exists only to give "most recent rights
  record for this artifact" a stable ordering — the sqlite version used
  SQLite's implicit `rowid` for this, which Postgres has no equivalent of.
