/**
 * The site's main web address, used anywhere a full, absolute URL is
 * needed (in the sitemap, in robots.txt's "Sitemap:" line, and in
 * structured data that search engines read). This can be overridden with
 * an environment variable, so it's ready for a future custom domain. If
 * nothing is set, it defaults to the current deployment address, so local
 * and test builds still produce valid, working URLs.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://si-past-papers.vercel.app";

export const SITE_NAME = "SI National Exam Archive";
