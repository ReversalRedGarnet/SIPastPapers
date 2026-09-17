// `"use server"` marks every function in this file as a "Server Action":
// code that always runs on the server (so it can safely write to the
// database), but that a form or button in a client component can call
// directly -- see how the exam detail page passes reportIssueAction
// straight to a <button>'s formAction. There's no separate API route to
// write or fetch() call to make by hand; Next.js wires the two together.
"use server";

import { redirect } from "next/navigation";
import { createIssue } from "@/lib/db/queries";

const VALID_ISSUE_TYPES = [
  "wrong_metadata",
  "missing_or_corrupt",
  "suspected_authenticity",
  "rights_concern",
  "other",
];

/**
 * Handles the "report a problem" form on a paper's page: takes in what
 * someone reports and saves it. This is just the intake step — it only
 * records the report. Actually putting a paper on hold, reviewing the
 * report, and resolving it are separate steps done later by the operator
 * through the command-line tool, and aren't built yet.
 */
// `FormData` is a standard web API representing everything submitted in an
// HTML form; `.get("artifactId")` reads one named field's value back out
// (or null if it wasn't present). `String(...)` explicitly converts
// whatever comes back into plain text, the same way `Number(...)` and
// `Boolean(...)` convert to those other types elsewhere in this project.
export async function reportIssueAction(formData: FormData): Promise<void> {
  const artifactId = String(formData.get("artifactId") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "/");
  const issueType = String(formData.get("issueType") ?? "other");
  const description = String(formData.get("description") ?? "").trim();
  // `||` (as opposed to `??`, used everywhere else in this project) also
  // falls back to the right-hand side, but treats *any* "empty-ish" value
  // -- including an empty string, not just missing/null/undefined -- as
  // reason to use the fallback. That distinction matters here: after
  // `.trim()`, a contact field that was typed as just blank spaces becomes
  // "", and `||` correctly treats that the same as "no contact given."
  const contact = String(formData.get("contact") ?? "").trim() || null;

  if (!artifactId || !description) {
    // `encodeURIComponent` makes arbitrary text safe to place inside a URL,
    // escaping characters (spaces, punctuation, etc.) that would otherwise
    // break the address. `redirect(...)` is a Next.js function that sends
    // the visitor's browser to a different address.
    redirect(`${returnTo}?reportError=${encodeURIComponent("Please describe the problem before submitting.")}`);
  }

  await createIssue({
    artifactId,
    issueType: VALID_ISSUE_TYPES.includes(issueType) ? issueType : "other",
    description,
    contact,
  });

  redirect(`${returnTo}?reported=1`);
}
