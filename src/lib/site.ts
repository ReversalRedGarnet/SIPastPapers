/**
 * The site's main web address, used anywhere a full, absolute URL is
 * needed (in the sitemap, in robots.txt's "Sitemap:" line, and in
 * structured data that search engines read). This can be overridden with
 * an environment variable, so it's ready for a future custom domain. If
 * nothing is set, it defaults to the current deployment address, so local
 * and test builds still produce valid, working URLs.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://sipastexams.com";

export const SITE_NAME = "SI National Exam Archive";

/**
 * The one inbox this whole site ever points visitors at -- for corrections
 * (the About page), and for anyone offering a paper the archive doesn't
 * have yet (the missing-papers page and the note shown on any not-yet-
 * recovered paper's own page). Kept in one place so every mailto link
 * stays in sync if this ever changes.
 */
export const CONTACT_EMAIL = "dorihaop@gmail.com";
