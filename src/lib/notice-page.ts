import type { NextRequest } from "next/server";

/**
 * A small, self-contained HTML page for the few times a download link
 * can't hand out its file -- "please wait" (src/lib/rate-limit-response.ts)
 * or "this year's zip isn't ready yet" (/api/download-year). Plain HTML
 * with its own styles, since these come from API routes, not the site's
 * React pages.
 */

/**
 * True when the request is a browser loading a page or the paper preview
 * frame (someone tapped a link, or the preview loaded), rather than a
 * script. Those visitors should see a readable page, not raw JSON.
 */
export function wantsHtml(request: NextRequest): boolean {
  const dest = request.headers.get("sec-fetch-dest");
  if (dest === "document" || dest === "iframe") return true;
  return (request.headers.get("accept") ?? "").includes("text/html");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Where a "go back" link should point: the page the visitor came from,
 * but only if it's on this same site (never an outside address),
 * otherwise the homepage.
 */
export function backHref(request: NextRequest): string {
  const referer = request.headers.get("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    return url.origin === request.nextUrl.origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}

/**
 * The page itself. `bodyHtml` is trusted HTML (escape anything from the
 * request with escapeHtml). Ends with "Go back" and "Homepage" links;
 * `target="_top"` matters when the page shows up inside a paper's preview
 * frame: it makes the link replace the whole page rather than just the
 * little preview box.
 */
export function noticePage(request: NextRequest, title: string, heading: string, bodyHtml: string): string {
  const back = escapeHtml(backHref(request));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — SI National Exam Archive</title>
<style>
  body { font-family: system-ui, sans-serif; line-height: 1.5; margin: 0; padding: 1.5rem 1rem; color: #201f1e; background: #fff; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  a { color: #1e3a5f; }
  @media (prefers-color-scheme: dark) { body { color: #f3f2f1; background: #1f1f1f; } a { color: #5b8def; } }
</style>
</head>
<body>
<main>
  <h1>${heading}</h1>
  ${bodyHtml}
  <p><a href="${back}" target="_top">Go back</a> · <a href="/" target="_top">Homepage</a></p>
</main>
</body>
</html>`;
}
