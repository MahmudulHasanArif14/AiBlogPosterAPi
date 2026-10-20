import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { htmlEscape } from "@/lib/article";
type FeedPost = { title: string; slug: string; excerpt: string; canonical_url: string | null; published_at: string | null; location_id: string; image_url: string | null; image_alt: string | null; image_credit: string | null; image_source_url: string | null; image_license: string | null; image_license_url: string | null; };
export async function GET(req: NextRequest) {
  const location = req.nextUrl.searchParams.get("location");
  const db = supabaseAdmin();
  let q = db
    .from("posts")
    .select(
      "title,slug,excerpt,canonical_url,published_at,location_id,image_url,image_alt,image_credit,image_source_url,image_license,image_license_url",
    )
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(50);
  if (location) {
    const { data: loc } = await db
      .from("locations")
      .select("id")
      .eq("slug", location)
      .eq("enabled", true)
      .single();
    if (!loc) return new Response("Unknown location", { status: 404 });
    q = q.eq("location_id", loc.id);
  }
  const { data } = await q;
  const base = (
    process.env.SITE_URL || "https://content.westerncars.co.uk"
  ).replace(/\/$/, "");





const posts = (data ?? []) as unknown as FeedPost[];
const items = posts
  .map(
    (p) => `
      <item>
        <title>${htmlEscape(p.title)}</title>
        <link>${htmlEscape(p.canonical_url || `${base}/posts/${p.slug}`)}</link>
        <guid isPermaLink="true">${htmlEscape(p.canonical_url || `${base}/posts/${p.slug}`)}</guid>
        <pubDate>${new Date(p.published_at || Date.now()).toUTCString()}</pubDate>
        <description>${htmlEscape(p.excerpt)}</description>
        ${
          p.image_url
            ? `<media:content url="${htmlEscape(p.image_url)}" medium="image" />`
            : ""
        }
        ${
          p.image_credit
            ? `<media:credit>${htmlEscape(p.image_credit)}</media:credit>`
            : ""
        }
        ${
          p.image_source_url
            ? `<media:description>${htmlEscape(
                `${p.image_alt || p.title} â€” Source: ${p.image_source_url}${
                  p.image_license ? ` â€” Licence: ${p.image_license}` : ""
                }${
                  p.image_license_url ? ` â€” ${p.image_license_url}` : ""
                }`,
              )}</media:description>`
            : ""
        }
      </item>
    `,
  )
  .join("");









  const xml = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
  <title>Western Cars ${location || "Travel"} Articles</title>
  <link>${htmlEscape(base)}</link>
  <description>Published Western Cars travel articles</description>${items}</channel>
  </rss>`;
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300",
    },
  });
}
