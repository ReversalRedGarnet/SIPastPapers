// `"use server"` marks every function in this file as a "Server Action":
// code that always runs on the server (so it can safely write to the
// database), but that a form or button in a client component can call
// directly -- see how the exam detail page passes reportIssueAction
// straight to a <button>'s formAction. There's no separate API route to
// write or fetch() call to make by hand; Next.js wires the two together.
"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createIssue, getPublicArtifactPath } from "@/lib/db/queries";
import { identifyVisitor, rateLimit, VISITOR_COOKIE, VISITOR_COOKIE_OPTIONS } from "@/lib/rate-limit";
import { logEvent, visitorLogFields } from "@/lib/log";
import { parseReportForm, safeReturnTo } from "@/lib/report-form";
import { reportStatusHref } from "@/lib/report-status";

/**
 * Handles the "report a problem" form on a paper's page: takes in what
 * someone reports and saves it. This is just the intake step — it only
 * records the report. Actually putting a paper on hold, reviewing the
 * report, and resolving it are separate steps done later by the operator
 * through the command-line tool, and aren't built yet.
 *
 * This is a Server Action, which (unlike the rendered form) can be POSTed
 * to directly with any values -- so every field is checked first (see
 * parseReportForm), and a report is only saved against a paper that
 * really exists and is public.
 *
 * `redirect(...)` is a Next.js function that sends the visitor's browser
 * to a different address -- here, back to the paper's page with a fixed
 * status code the page turns into a message (see
 * src/lib/report-status.ts). It also stops this function right there.
 */
// `FormData` is a standard web API representing everything submitted in an
// HTML form; `.get("artifactId")` reads one named field's value back out
// (or null if it wasn't present).
export async function reportIssueAction(formData: FormData): Promise<void> {
  // Only used when we can't work out the paper's page ourselves.
  const fallbackReturnTo = safeReturnTo(formData.get("returnTo"));

  // `cookies()` and `headers()` read the incoming request; they're async
  // in this version of Next.js, hence the `await`.
  const cookieStore = await cookies();
  const headerList = await headers();
  const visitor = identifyVisitor(cookieStore.get(VISITOR_COOKIE)?.value, headerList.get("x-forwarded-for"));
  if (visitor.newCookie) cookieStore.set(VISITOR_COOKIE, visitor.newCookie, VISITOR_COOKIE_OPTIONS);
  const logFields = visitorLogFields(visitor, headerList.get("user-agent"));

  const parsed = parseReportForm(formData);

  // A bot filled in the hidden spam-trap field: act as if it worked, so it
  // has no reason to try again differently, but save nothing.
  if (parsed.kind === "spam") {
    logEvent("report", { outcome: "spam", ...logFields });
    redirect(reportStatusHref(fallbackReturnTo, "sent"));
  }
  if (parsed.kind === "invalid") {
    logEvent("report", { outcome: "invalid", code: parsed.code, ...logFields });
    redirect(reportStatusHref(fallbackReturnTo, parsed.code));
  }

  // A few reports per visitor every few minutes (see src/lib/rate-limit.ts),
  // so the form can't be used to flood the issues table. Every report is a
  // separate item -- unlike files, sending "the same" report again counts.
  const limit = rateLimit("report", visitor, randomUUID());
  if (!limit.allowed) {
    logEvent("rate_limited", { bucket: "report", scope: limit.scope, retryAfterSeconds: limit.retryAfterSeconds, ...logFields });
    redirect(reportStatusHref(fallbackReturnTo, "too-many-reports"));
  }

  const paperPath = await getPublicArtifactPath(parsed.artifactId);
  if (!paperPath) {
    logEvent("report", { outcome: "unknown_paper", ...logFields });
    redirect(reportStatusHref(fallbackReturnTo, "unknown-paper"));
  }

  await createIssue({
    artifactId: parsed.artifactId,
    issueType: parsed.issueType,
    description: parsed.description,
    contact: parsed.contact,
  });
  limit.record();
  // Never the report's text or contact details -- just that one was saved.
  logEvent("report", { outcome: "saved", artifactId: parsed.artifactId, issueType: parsed.issueType, ...logFields });

  redirect(reportStatusHref(paperPath, "sent"));
}
