/**
 * True if `value` looks like a database id (a UUID such as
 * "eab44084-e61f-4a48-9dcb-14324c5ccfe7"). Check this before using a
 * visitor-supplied id in a query: Postgres rejects anything else in a
 * uuid column with an error, which would otherwise surface as a crash
 * (500) rather than a plain "not found".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
