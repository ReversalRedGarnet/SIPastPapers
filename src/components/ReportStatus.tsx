"use client";

import { useSearchParams } from "next/navigation";
import { isReportStatusCode, REPORT_STATUS_MESSAGES, REPORT_STATUS_PARAM } from "@/lib/report-status";

/**
 * Shows the "thanks, logged" (or "please describe the problem") message
 * after the report form is submitted. It reads the `?report=` code in the
 * browser rather than on the server, so the paper page itself doesn't
 * depend on the address's query string and can be cached and reused for
 * every visitor. It must sit inside a <Suspense> boundary on the page
 * (see the paper page), as Next.js requires for useSearchParams.
 */
export function ReportStatus() {
  const code = useSearchParams().get(REPORT_STATUS_PARAM);
  if (!isReportStatusCode(code)) return null;

  const message = REPORT_STATUS_MESSAGES[code];
  return (
    <div className="confirmation" role={message.role}>
      <p>{message.text}</p>
    </div>
  );
}
