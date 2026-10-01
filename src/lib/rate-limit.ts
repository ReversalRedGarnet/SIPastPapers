import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Limits how much any one visitor can open or download in a short time,
 * to protect the archive from scraping and runaway costs -- without
 * blocking ordinary students.
 *
 * How it decides who "one visitor" is:
 *   - Each browser gets an anonymous, signed ID cookie the first time it
 *     opens a paper. The limit mainly applies per cookie, so 30 students
 *     at a school sharing one internet address each get their own
 *     allowance.
 *   - Every request also counts towards a much larger allowance for its
 *     internet (IP) address, as a backstop against floods.
 *   - A request without a valid cookie (first visit, or a script that
 *     throws cookies away) counts against a separate, smaller per-address
 *     allowance -- so discarding the cookie never buys a fresh allowance.
 *
 * What counts: each *different* paper (or year zip, or report) within the
 * last 10 minutes, not each web request. Opening the same paper again,
 * retrying a failed download, or resuming one counts once.
 *
 * Counting happens in two steps: rateLimit() checks before any work is
 * done, and the caller calls record() only once it has actually served
 * the item -- so a "not found" or a failure doesn't use up any allowance.
 *
 * Every number can be changed with environment variables (see
 * .env.example). The counts are kept in memory, per running copy of the
 * app: they reset on redeploy and aren't shared between copies, so this is
 * a soft limit. Large-scale floods are for the hosting firewall to handle.
 */

export type RateLimitBucket = "preview" | "open" | "zip" | "report";

export interface RateLimitConfig {
  windowMs: number;
  /** Distinct items per visitor cookie. */
  perVisitor: number;
  /** Distinct items per IP address, across everyone using it (the backstop). */
  perIp: number;
  /** Distinct items per IP address from requests with no valid cookie. */
  perIpNoCookie: number;
}

const DEFAULT_WINDOW_SECONDS = 600;

const DEFAULT_LIMITS: Record<RateLimitBucket, Omit<RateLimitConfig, "windowMs">> = {
  preview: { perVisitor: 120, perIp: 1000, perIpNoCookie: 300 },
  open: { perVisitor: 40, perIp: 600, perIpNoCookie: 60 },
  zip: { perVisitor: 3, perIp: 20, perIpNoCookie: 10 },
  report: { perVisitor: 5, perIp: 30, perIpNoCookie: 10 },
};

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[rate-limit] ${message}`);
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value > 0) return value;
  warnOnce(`${name}="${raw}" isn't a whole number above 0 -- using the default, ${fallback}.`);
  return fallback;
}

/**
 * The limits for one bucket, read from the environment each time (it's
 * cheap), e.g. RATE_LIMIT_OPEN_PER_VISITOR, RATE_LIMIT_ZIP_PER_IP,
 * RATE_LIMIT_PREVIEW_PER_IP_NO_COOKIE, RATE_LIMIT_WINDOW_SECONDS.
 */
export function rateLimitConfig(bucket: RateLimitBucket): RateLimitConfig {
  const prefix = `RATE_LIMIT_${bucket.toUpperCase()}`;
  const defaults = DEFAULT_LIMITS[bucket];
  return {
    windowMs: envPositiveInt("RATE_LIMIT_WINDOW_SECONDS", DEFAULT_WINDOW_SECONDS) * 1000,
    perVisitor: envPositiveInt(`${prefix}_PER_VISITOR`, defaults.perVisitor),
    perIp: envPositiveInt(`${prefix}_PER_IP`, defaults.perIp),
    perIpNoCookie: envPositiveInt(`${prefix}_PER_IP_NO_COOKIE`, defaults.perIpNoCookie),
  };
}

// --- the visitor cookie ------------------------------------------------------

/**
 * The `__Host-` prefix makes browsers insist the cookie is Secure, set for
 * the whole site (Path=/) and not shared with any other (sub)domain.
 */
export const VISITOR_COOKIE = "__Host-sipp_vid";

export const VISITOR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
};

let fallbackSecret: string | undefined;

/**
 * The key used to sign visitor cookies, so a script can't simply make up
 * its own IDs to get fresh allowances. Set RATE_LIMIT_SECRET in production;
 * without it, each running copy of the app invents its own, which works
 * but means cookies issued by one copy look invalid to another. (Also
 * used as the key for anonymising addresses in logs -- see src/lib/log.ts.)
 */
export function signingSecret(): string {
  const configured = process.env.RATE_LIMIT_SECRET;
  if (configured) return configured;
  if (!fallbackSecret) {
    fallbackSecret = randomBytes(32).toString("hex");
    warnOnce("RATE_LIMIT_SECRET isn't set -- using a temporary per-process key (set it in production).");
  }
  return fallbackSecret;
}

function sign(id: string): string {
  return createHmac("sha256", signingSecret()).update(id).digest("base64url");
}

/** A new visitor ID and the cookie value carrying it: "<id>.<signature>". */
export function mintVisitorCookie(): { id: string; value: string } {
  // base64url never contains ".", so the value always splits cleanly.
  const id = randomBytes(16).toString("base64url");
  return { id, value: `${id}.${sign(id)}` };
}

/** The visitor ID in a cookie value, or null if it's missing, malformed, or wasn't signed by us. */
export function verifyVisitorCookie(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [id, signature] = parts;
  const given = Buffer.from(signature);
  const expected = Buffer.from(sign(id));
  // timingSafeEqual compares in constant time, so how long the comparison
  // takes gives away nothing about how close a guessed signature was.
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

// --- who is asking -------------------------------------------------------------

export interface Visitor {
  ip: string;
  /** From a valid cookie, or null if the request didn't carry one. */
  visitorId: string | null;
  /** When the request had no valid cookie: a fresh cookie value to send back. */
  newCookie: string | null;
}

/**
 * `forwardedFor` is the X-Forwarded-For header. On Vercel its first entry
 * is the visitor's real address, set by Vercel itself (a visitor can't
 * fake it).
 */
export function identifyVisitor(cookieValue: string | undefined, forwardedFor: string | null): Visitor {
  const ip = forwardedFor?.split(",")[0].trim() || "unknown";
  const visitorId = verifyVisitorCookie(cookieValue);
  if (visitorId) return { ip, visitorId, newCookie: null };
  return { ip, visitorId: null, newCookie: mintVisitorCookie().value };
}

// --- counting -------------------------------------------------------------------

/** For each counting key: the items seen in the current window, and when each was first seen. */
const seen = new Map<string, Map<string, number>>();

const SWEEP_THRESHOLD = 10_000;

function liveItems(key: string, now: number, windowMs: number): Map<string, number> {
  let items = seen.get(key);
  if (!items) {
    items = new Map();
    seen.set(key, items);
  }
  for (const [item, firstSeen] of items) {
    if (now - firstSeen >= windowMs) items.delete(item);
  }
  return items;
}

/** Stops memory growing forever from visitors who never come back. */
function sweep(now: number, windowMs: number): void {
  if (seen.size < SWEEP_THRESHOLD) return;
  for (const key of seen.keys()) {
    if (liveItems(key, now, windowMs).size === 0) seen.delete(key);
  }
}

export type RateLimitScope = "visitor" | "ip" | "no-cookie";

export type RateLimitResult =
  | { allowed: true; record: () => void }
  | { allowed: false; retryAfterSeconds: number; scope: RateLimitScope };

/**
 * Checks whether `visitor` may have `item` (e.g. a file id) from `bucket`
 * right now. If allowed, call `record()` once the item has actually been
 * served; if not, `retryAfterSeconds` says how long until an allowance
 * frees up, and `scope` which allowance ran out.
 */
export function rateLimit(
  bucket: RateLimitBucket,
  visitor: Visitor,
  item: string,
  now: number = Date.now()
): RateLimitResult {
  const config = rateLimitConfig(bucket);
  sweep(now, config.windowMs);

  const checks: { key: string; limit: number; scope: RateLimitScope }[] = [
    visitor.visitorId
      ? { key: `${bucket}:visitor:${visitor.visitorId}`, limit: config.perVisitor, scope: "visitor" }
      : { key: `${bucket}:no-cookie:${visitor.ip}`, limit: config.perIpNoCookie, scope: "no-cookie" },
    { key: `${bucket}:ip:${visitor.ip}`, limit: config.perIp, scope: "ip" },
  ];

  let blocked: { retryAfterMs: number; scope: RateLimitScope } | null = null;
  for (const check of checks) {
    const items = liveItems(check.key, now, config.windowMs);
    // Something already counted in this window is always allowed again.
    if (items.has(item) || items.size < check.limit) continue;
    // The allowance frees up when the oldest counted item drops out of
    // the window.
    const retryAfterMs = Math.min(...items.values()) + config.windowMs - now;
    if (!blocked || retryAfterMs > blocked.retryAfterMs) blocked = { retryAfterMs, scope: check.scope };
  }

  if (blocked) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil(blocked.retryAfterMs / 1000)),
      scope: blocked.scope,
    };
  }

  return {
    allowed: true,
    record: () => {
      for (const check of checks) {
        const items = liveItems(check.key, now, config.windowMs);
        if (!items.has(item)) items.set(item, now);
      }
    },
  };
}

/** Used only in tests: forgets everything counted so far. */
export function resetRateLimitsForTests(): void {
  seen.clear();
}
