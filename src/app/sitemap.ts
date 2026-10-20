import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/posts-repository";
import { supabaseAdmin } from "@/lib/supabase";

export const revalidate = 300;

type SitemapPost = {
  slug: string;
  published_at: string | null;
  updated_at: string | null;
  image_url: string | null;
  canonical_url: string | null;
};

/**
 * Sitemap for the central hub only.
 *
 * Every URL here is on the central content domain, because that is where these
 * pages are served from. A consuming website generates its own sitemap for its
 * own /blog/ URLs on its own domain; the two must never be mixed, or the two
 * copies of an article compete with each other in search.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("posts")
    .select("slug,published_at,updated_at,image_url,canonical_url")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(5000);

  if (error) {
    console.error("sitemap_query_failed:", error.message);
  }

  const posts = ((data ?? []) as unknown as SitemapPost[]).filter((post) => {
    // Never advertise an article whose canonical URL points somewhere else.
    if (!post.canonical_url) {
      return true;
    }

    try {
      return new URL(post.canonical_url).origin === new URL(base).origin;
    } catch {
      return false;
    }
  });

  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${base}/api-docs`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    ...posts.map((post) => ({
      url: `${base}/posts/${post.slug}`,
      lastModified: post.updated_at
        ? new Date(post.updated_at)
        : post.published_at
          ? new Date(post.published_at)
          : new Date(),
      changeFrequency: "monthly" as const,
      priority: 0.8,
      ...(post.image_url ? { images: [post.image_url] } : {}),
    })),
  ];
}
