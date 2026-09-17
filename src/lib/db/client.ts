import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

let pool: Pool | undefined;

// --- Automatically retrying when the database connection has a brief hiccup ---
//
// Our database provider (Neon) sometimes "sleeps" its database to save
// resources when it hasn't been used in a while, and takes a moment to
// wake back up. During that moment, trying to connect can briefly fail
// even though nothing is actually wrong. So here we detect that specific
// kind of failure and retry it automatically, rather than giving up right
// away. We only retry connection problems like this — never a genuine
// error in the data or the SQL itself, since retrying that would just fail
// again in exactly the same way.
const TRANSIENT_CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]);

function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_CONNECTION_ERROR_CODES.has(code)) return true;
  // These particular connection failures don't come with an error code
  // (unlike the ones checked above), so we have to recognize them by their
  // message text instead.
  return /connection terminated/i.test(err.message);
}

const RETRY_BASE_DELAY_MS = 500;

/**
 * How patient we are about a slow or failing connection depends on who's
 * asking:
 *   - "web": someone visiting a page in their browser. If the database is
 *     genuinely down, we want to fail quickly rather than making a real
 *     visitor sit and wait for a long time.
 *   - "cli": the command-line tool, running as a batch job with nobody
 *     waiting on a webpage. Here it's worth waiting longer and trying a
 *     few more times, since there's no rush.
 * The app defaults to the "web" settings automatically. The command-line
 * tool and the test suite switch to "cli" mode by setting the
 * DB_POOL_PROFILE environment variable before they start.
 */
interface RetryBudget {
  connectionTimeoutMillis: number;
  retryAttempts: number;
}

const RETRY_BUDGETS: Record<"web" | "cli", RetryBudget> = {
  web: { connectionTimeoutMillis: 5_000, retryAttempts: 1 },
  cli: { connectionTimeoutMillis: 15_000, retryAttempts: 3 },
};

function getRetryBudget(): RetryBudget {
  return RETRY_BUDGETS[process.env.DB_POOL_PROFILE === "cli" ? "cli" : "web"];
}

/**
 * Runs the given function, and if it fails because of a dropped/never-made
 * connection, tries again after a short pause (waiting a bit longer each
 * time: 500ms, then 1000ms, and so on). Any other kind of failure is
 * passed straight through immediately, with no retry. In "web" mode
 * (retryAttempts = 1), this effectively never retries at all.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const { retryAttempts } = getRetryBudget();
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= retryAttempts || !isTransientConnectionError(err)) throw err;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * We deliberately look this up only when it's actually needed (inside
 * getPool(), below), rather than once when the file is first loaded. That
 * way, if something else needs to set up the connection details first
 * (like a test loading its environment variables), it still has a chance
 * to do so before this is read.
 */
function resolveConnectionString(): string {
  const url = process.env.DATABASE_URL_POOLED;
  if (!url) {
    throw new Error(
      "Missing DATABASE_URL_POOLED. Postgres is required for both local dev and production " +
        "(there is no local/offline fallback) — see .env.example and README.md."
    );
  }
  return url;
}

/**
 * The app's shared connection pool, pointed at Neon's "pooled" connection
 * address (see .env.example). This lets many short-lived requests share
 * connections instead of each one opening a brand new direct connection to
 * Postgres. Database migrations are run separately, using a different,
 * direct (non-pooled) connection — see scripts/db-migrate.ts and
 * migrations/README.md.
 */
function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: resolveConnectionString(),
    // Without a limit here, a stuck connection (say, a database that's
    // taking a long time to wake up) could hang indefinitely instead of
    // failing in a predictable amount of time. This puts a clear time
    // limit on it, so callers (and the retry logic above) always get a
    // definite answer — success or failure — rather than an endless wait.
    connectionTimeoutMillis: getRetryBudget().connectionTimeoutMillis,
  });
  return pool;
}

/**
 * Keeps track of which database connection the current transaction (see
 * withTransaction, below) is using. This means any query()/queryOne() call
 * made anywhere during that transaction — even deep inside a function that
 * has no idea a transaction is even happening — automatically runs on
 * that same connection, instead of grabbing a random one from the pool.
 * That's what lets different functions call query() and withTransaction()
 * independently while still working correctly together.
 */
const activeClient = new AsyncLocalStorage<PoolClient>();

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = activeClient.getStore();
  // We only retry when we're NOT already inside a transaction. If a query
  // inside an already-open transaction hits a dropped connection, that
  // whole transaction is effectively dead — retrying just this one
  // statement (on a broken connection, or a fresh one that never ran the
  // earlier statements) would be wrong. In that case we let it fail and
  // pass the error up to whatever called withTransaction.
  const result = client
    ? await client.query<T>(text, params)
    : await withRetry(() => getPool().query<T>(text, params));
  return result.rows;
}

/**
 * Same as query() above, but never retries. This matters for a write that
 * isn't wrapped in a transaction and has no way to safely run twice: if a
 * connection drops right after the write was sent but before we get
 * confirmation back, we genuinely don't know whether it went through.
 * Retrying could create a duplicate. It's safer to just fail and let the
 * caller know, instead of risking a duplicate row. (Its only current use
 * is createIssue in src/lib/db/queries.ts.)
 */
export async function queryWithoutRetry<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = activeClient.getStore();
  const result = client ? await client.query<T>(text, params) : await getPool().query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

/**
 * Runs the given function as a single database transaction: either
 * everything inside it succeeds and gets saved together, or if anything
 * fails, all of it is undone together. If we're already inside a
 * transaction (this function was called again from within itself, or a
 * test wrapped everything in withRolledBackTransaction below), we just
 * reuse that existing transaction rather than trying to start a separate
 * one nested inside it — Postgres doesn't really support true nested
 * transactions, and the outer one will already save or undo everything
 * when it finishes.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (activeClient.getStore()) return fn();

  // It's safe to retry just the act of connecting here: since nothing has
  // been sent to the database yet, trying again on a fresh connection
  // can't accidentally repeat or skip any work.
  const client = await withRetry(() => getPool().connect());
  try {
    await client.query("begin");
    const result = await activeClient.run(client, fn);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Used only in tests. Works just like withTransaction above, except it
 * always undoes everything at the end, whether or not the function
 * succeeded. This lets tests run real queries against the real database
 * without leaving any test data behind afterwards.
 */
export async function withRolledBackTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const client = await withRetry(() => getPool().connect());
  try {
    await client.query("begin");
    return await activeClient.run(client, fn);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** Used only in tests: closes the connection pool so the test process can exit right away instead of hanging. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
