import { isUuid } from "@/lib/uuid";
import type { ReportStatusCode } from "@/lib/report-status";

/**
 * Reads and checks a submitted "report a problem" form (see the paper
 * page and its reportIssueAction). Kept separate from the Server Action
 * itself, with no database access, so every rule here can be unit tested
 * directly.
 *
 * A Server Action can be sent any values at all by anyone, not only what
 * our own form would send, so nothing here trusts the form to be
 * well-behaved.
 */

export const ISSUE_TYPES = [
  "wrong_metadata",
  "missing_or_corrupt",
  "suspected_authenticity",
  "rights_concern",
  "other",
] as const;

export const DESCRIPTION_MAX_LENGTH = 2000;
export const CONTACT_MAX_LENGTH = 200;

/**
 * The name of a form field that's hidden from people (and from screen
 * readers) but that spam bots, which fill in every field they find, tend
 * to fill. A report with anything in it is quietly dropped.
 */
export const HONEYPOT_FIELD = "website";

export type ParsedReportForm =
  | {
      kind: "ok";
      artifactId: string;
      issueType: (typeof ISSUE_TYPES)[number];
      description: string;
      contact: string | null;
    }
  | { kind: "invalid"; code: ReportStatusCode }
  | { kind: "spam" };

function field(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "").trim();
}

export function parseReportForm(formData: FormData): ParsedReportForm {
  if (field(formData, HONEYPOT_FIELD)) return { kind: "spam" };

  const artifactId = field(formData, "artifactId");
  if (!isUuid(artifactId)) return { kind: "invalid", code: "unknown-paper" };

  const description = field(formData, "description");
  if (!description) return { kind: "invalid", code: "missing-details" };

  // `||` (as opposed to `??`) also falls back for an empty string: a
  // contact field typed as just spaces becomes "" after trimming, and
  // that should count as "no contact given."
  const contact = field(formData, "contact") || null;
  if (description.length > DESCRIPTION_MAX_LENGTH || (contact?.length ?? 0) > CONTACT_MAX_LENGTH) {
    return { kind: "invalid", code: "too-long" };
  }

  const rawIssueType = field(formData, "issueType");
  // `.find(...)` hands back the matching allowed value itself (already the
  // right type), or undefined if the submitted value isn't one of them.
  const issueType = ISSUE_TYPES.find((t) => t === rawIssueType) ?? "other";

  return { kind: "ok", artifactId, issueType, description, contact };
}

/**
 * Where to send someone back to when we can't work out their paper's page
 * from the database: the address their form says it came from, but only
 * if it's a path on this site. A path starting with "//" is excluded
 * because browsers treat it as an address on a different site.
 */
export function safeReturnTo(value: FormDataEntryValue | null): string {
  const raw = String(value ?? "/");
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}
