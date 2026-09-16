/**
 * Canonical production origin, used anywhere metadata needs an absolute URL
 * (sitemap entries, robots.txt's Sitemap: line, JSON-LD `url`/`contentUrl`).
 * Overridable via env for a future custom domain; defaults to the current
 * Vercel deployment so local/dev builds still produce valid absolute URLs.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://si-past-papers.vercel.app";

export const SITE_NAME = "SI National Exam Archive";
