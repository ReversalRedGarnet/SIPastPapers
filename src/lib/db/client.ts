import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

// `Pool | undefined` -- a union again (see src/types/domain.ts), this time
// with `undefined` instead of `null`: this variable either holds a real
// Pool once one's been created, or is simply "not set yet."
let pool: Pool | undefined;

// --- retry-with-backoff for transient connection failures -------------------
//
// Observed against Neon: acquiring a connection can fail with ECONNRESET
// (rather than a clean auth error) while the pooler/proxy is waiting on a
// suspended compute to wake from Neon's free/scale-tier auto-suspend — the
// `pg` client has no built-in retry for that, and without one a single slow
// wake-up surfaces as a hard failure. Only retry errors that indicate the
// TCP/TLS connection itself was never established or was dropped — never a
// query-level error (bad SQL, constraint violation, etc.), which would just
// fail identically on retry.
const TRANSIENT_CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]);

// `unknown` means "this could be absolutely anything -- a caught error
// could be a real Error, or a plain string, or something else entirely."
// Unlike TypeScript's looser `any`, a value typed `unknown` can't be used
// for much until its actual type is checked, which is exactly what the
// `instanceof Error` check below does: "is this specific value actually an
// Error object?"
function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_CONNECTION_ERROR_CODES.has(code)) return true;
  // Covers both "Connection terminated unexpectedly" (socket dropped) and
  // "Connection terminated due to connection timeout" (pg's own
  // connectionTimeoutMillis firing) — neither carries an .code, only this
  // message text differs between them.
  return /connection terminated/i.test(err.message);
}

const RETRY_BASE_DELAY_MS = 500;

/**
 * How long to wait for a connection, and how many times to retry a
 * transient failure, differs by *who's* waiting:
 *   - "web": a visitor's page load. A real outage should fail fast rather
 *     than hang the request for tens of seconds only to possibly be killed
 *     mid-retry by the platform's own function timeout anyway.
 *   - "cli": an operator-run batch script (ingest, bulk approve-rights,
 *     etc.), where nothing else is waiting on the result and it's worth
 *     riding out a slow Neon cold-start rather than failing on the first
 *     blip.
 * "web" is the default (safe for the Next.js app without any config);
 * scripts/cli.ts and the DB test suites opt into "cli" explicitly by
 * setting DB_POOL_PROFILE=cli before the pool is ever created (it's read
 * lazily — see resolveConnectionString below — so this only has to happen
 * before the first actual query/connect, not before this module loads).
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
 * Retries `fn` up to the active profile's retryAttempts with exponential
 * backoff (500ms, 1000ms, ...), but only when the failure looks like a
 * dropped/never-established connection (see isTransientConnectionError) —
 * anything else (including a query that ran and failed) is rethrown
 * immediately. With the "web" profile's retryAttempts of 1, this makes zero
 * retries — the loop below still runs once, just never re-enters.
 */
// The `<T>` here is a "generic": a placeholder type, filled in by whatever
// this function is actually used with. `withRetry` needs to work for any
// kind of result -- a list of rows, a connection, anything -- so instead
// of hard-coding one specific return type, `T` stands in for "whatever
// type `fn` resolves to," and TypeScript fills it in automatically each
// time this function is called.
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const { retryAttempts } = getRetryBudget();
  let attempt = 0;
  // `for (;;)` with nothing in any of the three slots is a loop that never
  // ends on its own -- it only stops via the `return` inside, or the
  // `throw` that re-raises an error, both further down.
  for (;;) {
    // `try { ... } catch (err) { ... }`: run the code in `try`, and if it
    // throws an error partway through, jump straight to `catch` instead of
    // crashing the whole program, with the error available as `err`.
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
 * Deliberately computed lazily inside getPool() (not as a module-level
 * constant): a module-level constant would be evaluated as soon as
 * anything imports this module — including transitively — which can
 * happen before a test's setup code (or scripts/cli.ts's .env.local
 * loading) has had a chance to set the env var.
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
 * The app's runtime connection pool, pointed at Neon's pooled connection
 * string (see .env.example) so many short-lived serverless invocations
 * don't each open a direct Postgres connection. Schema migrations run
 * separately via scripts/db-migrate.ts against the *unpooled* DATABASE_URL
 * — see that file and migrations/README.md.
 */
function getPool(): Pool {
  if (pool) return pool;
  pool = new Pool({
    connectionString: resolveConnectionString(),
    // Without this, a stalled connection (e.g. a Neon compute that never
    // finishes waking up) hangs on the underlying OS/network timeout
    // instead of failing predictably — bound it so callers (and the retry
    // wrapper above) see a definite failure instead of an indefinite hang.
    // See getRetryBudget() above for what sets this per context.
    connectionTimeoutMillis: getRetryBudget().connectionTimeoutMillis,
  });
  return pool;
}

/**
 * Holds the PoolClient for the currently-open transaction (see
 * withTransaction below), so that query()/queryOne() calls made anywhere
 * during that transaction — including deep inside functions that have no
 * idea a transaction is open — automatically run on the same connection
 * instead of grabbing an arbitrary one from the pool. This is what lets
 * query() and withTransaction() be called independently throughout
 * queries.ts while still composing correctly.
 */
const activeClient = new AsyncLocalStorage<PoolClient>();

// `<T extends QueryResultRow = QueryResultRow>` builds on the generic idea
// above: `extends QueryResultRow` restricts `T` to only ever be filled in
// with something shaped like a database row, and `= QueryResultRow` is a
// fallback used when the caller doesn't specify one at all. Separately,
// `params: unknown[] = []` gives `params` a default value: if a caller
// doesn't pass anything for it, it's automatically treated as an empty
// list rather than being missing.
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = activeClient.getStore();
  // Only retry the no-transaction path: a query on an already-open
  // transaction client that hits a dropped connection means that
  // transaction is dead, and retrying just this one statement on a broken
  // connection (or against a fresh one that never ran the earlier
  // statements) would be wrong — let that fail and propagate up to whatever
  // called withTransaction.
  const result = client
    ? await client.query<T>(text, params)
    : await withRetry(() => getPool().query<T>(text, params));
  return result.rows;
}

/**
 * Like query(), but never retried. For a non-transactional write where a
 * retry after an ambiguous connection reset (statement sent, response
 * lost) could silently duplicate the write, and there's no natural unique
 * constraint to make a retry idempotent — see createIssue in
 * src/lib/db/queries.ts, its only caller. Failing once and surfacing the
 * error to the caller is safer than risking a duplicate row.
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
 * Runs `fn` inside a begin/commit-or-rollback block on one dedicated
 * connection, mirroring the old sqlite version's
 * db.exec("begin")/commit/rollback pattern. If a transaction is already
 * open (i.e. this is a nested call, or a test wrapped the whole thing in
 * withRolledBackTransaction below), reuses that connection instead of
 * opening a second, independent transaction — Postgres has no true nested
 * transactions without savepoints, and the outer transaction's eventual
 * commit/rollback already covers everything done here.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (activeClient.getStore()) return fn();

  // Retrying connect() is safe here: nothing has been sent to Postgres yet,
  // so a fresh attempt on a fresh connection can't duplicate or skip work.
  const client = await withRetry(() => getPool().connect());
  // A `finally` block (added on to try/catch -- see withRetry above) always
  // runs last, whether the `try` succeeded or the `catch` had to handle an
  // error. It's the right place for cleanup that must happen either way --
  // here, always giving the connection back to the pool.
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
 * Test-only: identical to withTransaction, except the transaction is
 * always rolled back at the end regardless of whether `fn` succeeded —
 * so tests can exercise real queries against the real (live Neon)
 * database without ever leaving data behind. See src/lib/db/*.test.ts and
 * scripts/cli-lib.test.ts.
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

/** Test-only: closes the pool so a test process can exit promptly instead of hanging on an open connection. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
