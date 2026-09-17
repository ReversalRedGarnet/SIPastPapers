import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // This tells search engines not to crawl our /api/ pages. Those
      // aren't real pages meant to be indexed — they're things like file
      // downloads and the "download whole year as a zip" feature. Letting
      // a search engine crawl the zip-download route would make it
      // rebuild a fresh zip file on every single crawl hit, for no benefit.
      disallow: "/api/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
