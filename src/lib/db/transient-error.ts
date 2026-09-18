/**
 * Detects a transient database *connection* failure (a dropped/never-made
 * connection, as opposed to a genuine error in the data or the SQL
 * itself) — e.g. Neon "sleeping" a database and taking a moment to wake
 * back up. Used by client.ts's retry logic (server-side), and by
 * src/app/error.tsx (a client component) to show a friendlier message
 * when that's what actually went wrong.
 *
 * Deliberately has no imports of its own (no `pg`, no Node built-ins), so
 * it's safe to import from a client component without pulling server-only
 * database code into the browser bundle.
 */
const TRANSIENT_CONNECTION_ERROR_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EPIPE"]);

export function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_CONNECTION_ERROR_CODES.has(code)) return true;
  // These particular connection failures don't come with an error code
  // (unlike the ones checked above), so we have to recognize them by their
  // message text instead.
  return /connection terminated/i.test(err.message);
}
