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
export async function reportIssueAction(formData: FormData): Promise<void> {
  const artifactId = String(formData.get("artifactId") ?? "").trim();
  const returnTo = String(formData.get("returnTo") ?? "/");
  const issueType = String(formData.get("issueType") ?? "other");
  const description = String(formData.get("description") ?? "").trim();
  const contact = String(formData.get("contact") ?? "").trim() || null;

  if (!artifactId || !description) {
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
