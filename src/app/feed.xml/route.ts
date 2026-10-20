import { NextRequest } from "next/server";
import { htmlEscape } from "@/lib/article";
import { listPublishedPosts, siteUrl } from "@/lib/posts-repository";

export const dynamic = "force-dynamic";

const LOCATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FEED_LIMIT = 50;

function xmlError(message: string, status: number) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<error>${htmlEscape(message)}</error>`,
    {
      status,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * RSS 2.0 feed of published articles, optionally filtered by location.
 *
 * GET /feed.xml
 * GET /feed.xml?location=brighton
 *
 * Only published articles appear. Item links use each article's canonical URL
 * on the central hub, which is where the article actually lives; consuming
 * websites publish their own feeds from their own domains if they want one.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("location");

  let location: string | null = null;

  if (raw !== null && raw.trim() !== "") {
    const candidate = raw.trim().toLowerCase();

    if (candidate.length > 80 || !LOCATION_SLUG.test(candidate)) {
      return xmlError("The location parameter must be a lowercase slug.", 400);
    }

    location = candidate;
  }

  let result;

  try {
    result = await listPublishedPosts(location, 1, FEED_LIMIT, false);
  } catch (error) {
    console.error(
      "feed_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return xmlError("Could not build the feed.", 500);
  }

  if ("notFound" in result) {
    return xmlError(`No enabled location matches '${location}'.`, 404);
  }

  const base = siteUrl();
  const self = location ? `${base}/feed.xml?location=${location}` : `${base}/feed.xml`;

  const title = result.location
    ? `Western Cars travel articles: ${result.location.name}`
    : "Western Cars travel articles";

  const items = result.posts
    .map((post) => {
      const link = String(post.canonical_url);
      const published = post.published_at
        ? new Date(String(post.published_at))
        : new Date();

      const media = post.image_url
        ? `\n      <media:content url="${htmlEscape(String(post.image_url))}" medium="image"${
            post.image_mime ? ` type="${htmlEscape(String(post.image_mime))}"` : ""
          } />`
        : "";

      const credit = post.image_credit
        ? `\n      <media:credit>${htmlEscape(String(post.image_credit))}</media:credit>`
        : "";

      const licence = post.image_license
        ? `\n      <media:description>${htmlEscape(
            [
              post.image_alt ?? post.title,
              post.image_source_url ? `Source: ${post.image_source_url}` : null,
              `Licence: ${post.image_license}`,
              post.image_license_url ? String(post.image_license_url) : null,
            ]
              .filter(Boolean)
              .join(" | "),
          )}</media:description>`
        : "";

      const category = post.category
        ? `\n      <category>${htmlEscape(String(post.category))}</category>`
        : "";

      return `    <item>
      <title>${htmlEscape(String(post.title))}</title>
      <link>${htmlEscape(link)}</link>
      <guid isPermaLink="true">${htmlEscape(link)}</guid>
      <pubDate>${published.toUTCString()}</pubDate>
      <description>${htmlEscape(String(post.excerpt))}</description>${category}${media}${credit}${licence}
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${htmlEscape(title)}</title>
    <link>${htmlEscape(base)}</link>
    <atom:link href="${htmlEscape(self)}" rel="self" type="application/rss+xml" />
    <description>Published Western Cars local travel and transport articles.</description>
    <language>en-GB</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
    },
  });
}
