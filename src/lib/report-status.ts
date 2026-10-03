/**
 * After someone submits the "report a problem" form on a paper's page,
 * they're sent back to that page with `?report=<code>` added to the
 * address, and the page shows the matching message below. Only these
 * fixed codes are ever shown -- the address never carries the message
 * text itself, so nobody can craft a link that makes our page display
 * words of their choosing.
 */
export const REPORT_STATUS_PARAM = "report";

export const REPORT_STATUS_MESSAGES = {
  sent: { text: "Thanks — this has been logged and will be reviewed.", role: "status" },
  "missing-details": { text: "Please describe the problem before submitting.", role: "alert" },
  "too-long": {
    text: "That's a bit too long to send — please keep the details under 2,000 characters and your email under 200.",
    role: "alert",
  },
  "too-many-reports": {
    text: "Thank you — you've sent several reports in the last few minutes. Please wait a few minutes before sending another.",
    role: "alert",
  },
  "unknown-paper": {
    text: "We couldn't match your report to a paper. Please reload this page and try again.",
    role: "alert",
  },
} as const;

// `keyof typeof X` means "any one of the property names of X" -- here,
// "sent" | "missing-details" -- so a typo in a code is a type error.
export type ReportStatusCode = keyof typeof REPORT_STATUS_MESSAGES;

export function isReportStatusCode(value: string | null): value is ReportStatusCode {
  return value !== null && Object.hasOwn(REPORT_STATUS_MESSAGES, value);
}

/**
 * The address to send someone back to: their paper's page, scrolled to the
 * report form. `returnTo` must be a path on this site (e.g.
 * "/exams/sisc-l1/2019/mathematics/paper-1"); any query string it already
 * has is kept.
 */
export function reportStatusHref(returnTo: string, code: ReportStatusCode): string {
  // Parsing against a throwaway origin lets URL do the query-string work
  // (adding "?" or "&" as needed); only the path part is handed back.
  const url = new URL(returnTo, "http://localhost");
  url.searchParams.set(REPORT_STATUS_PARAM, code);
  url.hash = "report-a-problem";
  return `${url.pathname}${url.search}${url.hash}`;
}
