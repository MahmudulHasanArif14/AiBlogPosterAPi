import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/posts-repository";

export default function robots(): MetadataRoute.Robots {
  const base = siteUrl();

  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/posts/", "/api-docs"],
        // Administrative and generation routes are already authenticated, but
        // they should not be crawled or indexed either.
        disallow: ["/api/cron", "/api/generate", "/api/status", "/api/admin/"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
