import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // /api/ covers file downloads and the zip-generating download-year
      // route -- not documents in their own right, and crawling the latter
      // would trigger a fresh zip build per hit for no indexing benefit.
      disallow: "/api/",
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
