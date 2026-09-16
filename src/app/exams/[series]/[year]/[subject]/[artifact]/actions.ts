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
 * Report-a-problem intake (spec section 8.5 step 1: "Receive the report
 * and identify the affected artifact"). This only records the report —
 * placing an artifact on rights hold, reviewing it, and resolving it are
 * later, separate CLI steps not built yet.
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
