/**
 * The site's main web address, used anywhere a full, absolute URL is
 * needed (in the sitemap, in robots.txt's "Sitemap:" line, and in
 * structured data that search engines read). This can be overridden with
 * an environment variable (NEXT_PUBLIC_SITE_URL). The default is the
 * site's real address: the bare domain (sipastexams.com) only redirects to
 * www, so canonical links and the sitemap must name www directly.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.sipastexams.com";

export const SITE_NAME = "SI National Exam Archive";

/**
 * The one inbox this whole site ever points visitors at -- for corrections
 * (the About page), and for anyone offering a paper the archive doesn't
 * have yet (the missing-papers page and the note shown on any not-yet-
 * recovered paper's own page). Kept in one place so every mailto link
 * stays in sync if this ever changes.
 */
export const CONTACT_EMAIL = "dorihaop@gmail.com";

/** The body of every "send us this paper" email (/missing and a placeholder's own page). */
export const ATTACHMENT_REQUEST = "Please attach the paper file to this email. Emails without an attachment can't be added.";

/** Who runs the site, and who doesn't, in full (the About page only). */
export const INDEPENDENCE_NOTE =
  "sipastexams.com is an independent, student-run archive. It is not run by or affiliated with the Solomon Islands Government, the Ministry of Education, or any exam authority.";

/**
 * The homepage banner's second line, under pastPapersOnlyNote(). Exactly
 * as approved: no full stop.
 */
export const INDEPENDENT_SITE_NOTE =
  "This is an independent website that is not affiliated with the Government of Solomon Islands";

/** Who builds and maintains the site (the About page's Contact line). */
export const OWNER_NAME = "Aziel Orihao";

/**
 * What the site doesn't have: the homepage banner's first line. The year
 * is this year in Honiara, so the line never goes stale.
 */
export function pastPapersOnlyNote(now: Date = new Date()): string {
  const year = new Intl.DateTimeFormat("en", { timeZone: "Pacific/Guadalcanal", year: "numeric" }).format(now);
  return `Past papers only. We do not have current-year (${year}) papers, official booklets, or exam answers for upcoming exams.`;
}
