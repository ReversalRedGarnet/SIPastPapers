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
} as const;

// `keyof typeof X` means "any one of the property names of X" -- here,
// "sent" | "missing-details" -- so a typo in a code is a type error.
export type ReportStatusCode = keyof typeof REPORT_STATUS_MESSAGES;

export function isReportStatusCode(value: string | null): value is ReportStatusCode {
  return value !== null && Object.hasOwn(REPORT_STATUS_MESSAGES, value);
}

/** The address to send someone back to: their paper's page, scrolled to the report form. */
export function reportStatusHref(returnTo: string, code: ReportStatusCode): string {
  return `${returnTo}?${REPORT_STATUS_PARAM}=${code}#report-a-problem`;
}
