import type { RightsStatus } from "@/types/domain";

/**
 * The rules for what the public may see and download, as SQL fragments
 * shared by every public read (src/lib/db/queries.ts) and by the proxy's
 * check of which page addresses exist (src/lib/db/public-paths.ts) -- kept
 * in one small module so the two can never disagree.
 */

/**
 * The rights statuses under which a paper may be public (PROJECT_SPEC
 * section 17.1). approveRights only ever sets one of these.
 */
export const APPROVED_RIGHTS_STATUSES: readonly RightsStatus[] = ["permission_granted", "public_domain_or_expired"];

/**
 * SQL, for use inside a query on `artifacts a`: true when the paper's most
 * recent rights record has an approved status and hasn't expired (a record
 * is still valid on its expiry date itself).
 *
 * The publish step already refuses papers without approved rights, but
 * rights can change after publishing (a hold, a denial, an expiry date
 * passing) -- so every public read checks them again too, rather than
 * trusting the "published" status alone.
 */
export const RIGHTS_CURRENTLY_APPROVED = `exists (
  select 1 from (
    select rr.rights_status, rr.expiry_date
    from rights_records rr
    where rr.artifact_id = a.id
    order by rr.created_at desc
    limit 1
  ) latest
  where latest.rights_status in (${APPROVED_RIGHTS_STATUSES.map((s) => `'${s}'`).join(", ")})
    and (latest.expiry_date is null or latest.expiry_date >= current_date)
)`;

/**
 * SQL, for a query joining `files f` to `artifacts a`: true only for the
 * paper's current file -- its most recently added one, the same one
 * PUBLIC_ARTIFACT_SELECT links to (ties broken by id, identically). Older
 * versions of a replaced file are never served or zipped, e.g. a scan
 * replaced because it showed a student's name.
 */
export const IS_CURRENT_FILE = `f.id = (
  select f2.id from files f2
  where f2.artifact_id = a.id
  order by f2.created_at desc, f2.id desc
  limit 1
)`;

/**
 * Every key a file is moved to when its paper is unpublished starts with
 * this (see quarantineKeyFor). Nothing stored under it is ever served.
 */
export const QUARANTINE_PREFIX = "quarantine/";

/**
 * SQL, for use inside a query on `artifacts a`: true when none of the
 * paper's stored files is in quarantine. Publishing moves quarantined files
 * back first, so a published paper never has one -- this makes sure that
 * even if it somehow did, the paper is treated as not servable rather than
 * served from quarantine.
 */
export const NO_QUARANTINED_FILES = `not exists (
  select 1 from files fq
  where fq.artifact_id = a.id and starts_with(fq.storage_key, '${QUARANTINE_PREFIX}')
)`;

/**
 * SQL: published, with rights currently approved and no file in
 * quarantine -- the only papers whose files may be served.
 */
export const SERVABLE = `(a.status = 'published' and ${RIGHTS_CURRENTLY_APPROVED} and ${NO_QUARANTINED_FILES})`;

/**
 * SQL: everything the public may see -- servable papers, plus "not yet
 * recovered" placeholders, which are listed so a gap is visible but have
 * no file (so no rights question arises).
 */
export const PUBLICLY_VISIBLE = `(${SERVABLE} or a.status = 'not_yet_recovered')`;
