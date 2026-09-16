/**
 * One-time (and re-runnable) schema + reference-data setup against the
 * real Postgres database. Run via `npm run db:migrate`.
 *
 * Deliberately separate from the app/CLI runtime: applying DDL from inside
 * a serverless function on every cold start would be unsafe (no operator
 * visibility, risk of two cold starts racing on the same migration). This
 * script is the only thing that ever runs migrations/*.sql or
 * seedReferenceData — see migrations/README.md.
 *
 * Uses the *unpooled* DATABASE_URL (not DATABASE_URL_POOLED, which the app
 * uses at runtime — see src/lib/db/client.ts): Neon recommends the direct
 * connection for migrations, and this is a single short-lived process, not
 * a fleet of serverless functions needing connection pooling.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { seedReferenceData } from "../src/lib/db/seed";

if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");

async function runMigrations(client: Client): Promise<void> {
  await client.query(
    `create table if not exists _migrations (
       id text primary key,
       applied_at timestamptz not null default now()
     )`
  );

  const { rows } = await client.query<{ id: string }>("select id from _migrations");
  const applied = new Set(rows.map((r) => r.id));

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[db-migrate] skipping ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    console.log(`[db-migrate] applying ${file}`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into _migrations (id) values ($1)", [file]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Missing DATABASE_URL (the unpooled/direct connection string — see .env.example). " +
        "DATABASE_URL_POOLED is for the app's runtime queries, not migrations."
    );
  }

  const client = new Client({ connectionString });
  await client.connect();
  console.log(`[db-migrate] connected`);

  try {
    await runMigrations(client);
    console.log(`[db-migrate] applying reference-data seed (idempotent)`);
    await seedReferenceData(client);
    console.log(`[db-migrate] done`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
