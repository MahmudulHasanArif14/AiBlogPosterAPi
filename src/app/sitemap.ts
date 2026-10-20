import type { MetadataRoute } from "next";
import { supabaseAdmin } from "@/lib/supabase";
type SitemapPost = { slug: string; published_at: string | null; image_url: string | null; };
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (
    process.env.SITE_URL || "https://content.westerncars.co.uk"
  ).replace(/\/$/, "");
  const db = supabaseAdmin();
  const { data } = await db
    .from("posts")
    .select("slug,published_at,image_url")
    .eq("status", "published");
  return [
    { url: base, lastModified: new Date() },
    ...((data ?? []) as unknown as SitemapPost[]).map((p) => ({
      url: `${base}/posts/${p.slug}`,
      lastModified: p.published_at ? new Date(p.published_at) : new Date(),
      ...(p.image_url ? { images: [p.image_url] } : {}),
    })),
  ];
}
