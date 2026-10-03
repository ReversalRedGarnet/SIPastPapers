/**
 * Counts the rows in every table of the TEST database (the Neon branch in
 * .env.test.local -- see src/lib/db/test-database-env.ts, which refuses to
 * run against the real one), inside a read-only transaction.
 *
 * CI runs it before and after the database tests to prove they left
 * nothing behind on the shared branch (every test's writes are meant to be
 * rolled back):
 *
 *   npx tsx scripts/test-db-rows.ts > rows-before.json
 *   npm run test:db
 *   npx tsx scripts/test-db-rows.ts --compare rows-before.json
 *
 * With --compare, exits 1 (listing the tables) if any count changed.
 */
import { readFileSync } from "node:fs";
import { loadTestDatabaseEnv } from "@/lib/db/test-database-env";

async function countRows(): Promise<Record<string, number>> {
  const { query, withTransaction } = await import("@/lib/db/client");
  return withTransaction(async () => {
    await query("set transaction read only");
    const tables = await query<{ name: string }>(
      `select table_name as name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`
    );
    const counts: Record<string, number> = {};
    for (const { name } of tables) {
      const [row] = await query<{ n: string }>(`select count(*) as n from "${name.replace(/"/g, '""')}"`);
      counts[name] = Number(row.n);
    }
    return counts;
  });
}

async function main() {
  loadTestDatabaseEnv();
  process.env.DB_POOL_PROFILE = "cli";
  const { closePool } = await import("@/lib/db/client");
  try {
    const counts = await countRows();
    const compareIndex = process.argv.indexOf("--compare");
    if (compareIndex === -1) {
      console.log(JSON.stringify(counts, null, 2));
      return;
    }
    const before: Record<string, number> = JSON.parse(readFileSync(process.argv[compareIndex + 1], "utf8"));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(counts)])]
      .filter((table) => before[table] !== counts[table])
      .map((table) => `${table}: ${before[table] ?? "-"} -> ${counts[table] ?? "-"}`);
    if (changed.length > 0) {
      console.error(`The database tests left rows behind on the test branch:\n  ${changed.join("\n  ")}`);
      process.exitCode = 1;
    } else {
      console.log(`No rows left behind (${Object.keys(counts).length} tables unchanged).`);
    }
  } finally {
    await closePool();
  }
}

void main();
