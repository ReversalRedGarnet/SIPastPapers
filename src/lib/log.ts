import { createHmac } from "node:crypto";
import { signingSecret, type Visitor } from "@/lib/rate-limit";

/**
 * Structured logs for downloads, rate-limit hits and reports, so real
 * usage patterns (and any visitors wrongly blocked) show up in the hosting
 * logs. Each event is one line of JSON -- e.g.
 *
 *   {"evt":"file","kind":"download","outcome":"served","fileId":"…","ip":"3f9a…","visitor":"81c2…","ua":"mobile",…}
 *
 * -- so the log search can filter on any field (evt:rate_limited, ua:mobile).
 *
 * Privacy (PROJECT_SPEC section 19): no raw IP address or visitor ID is
 * ever logged. Each is replaced by a short keyed fingerprint that changes
 * every day: enough to tell "the same visitor" apart within a day, but it
 * can't be turned back into the address, or matched across days.
 */

export function logEvent(evt: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ evt, ...fields }));
}

/** A 12-character, daily-changing, one-way fingerprint of `value` (see above). */
export function anonymize(value: string, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", signingSecret()).update(`log:${day}:${value}`).digest("hex").slice(0, 12);
}

/** A rough device category from the User-Agent header -- never the header itself. */
export function userAgentClass(userAgent: string | null): "bot" | "mobile" | "desktop" | "unknown" {
  if (!userAgent) return "unknown";
  if (/bot|crawl|spider|slurp|facebookexternalhit|whatsapp|preview/i.test(userAgent)) return "bot";
  if (/mobi|android|iphone|ipad/i.test(userAgent)) return "mobile";
  return "desktop";
}

/** The who/where fields shared by every request event. */
export function visitorLogFields(visitor: Visitor, userAgent: string | null): Record<string, unknown> {
  return {
    ip: anonymize(visitor.ip),
    visitor: visitor.visitorId ? anonymize(visitor.visitorId) : null,
    newVisitor: visitor.newCookie !== null,
    ua: userAgentClass(userAgent),
    // Which Vercel region served the request (unset when running locally).
    region: process.env.VERCEL_REGION ?? null,
  };
}
