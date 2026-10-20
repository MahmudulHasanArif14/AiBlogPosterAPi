import { NextResponse } from "next/server";
import { PUBLISHED_CACHE_CONTROL, apiError } from "@/lib/api-response";
import { getPublishedPost } from "@/lib/posts-repository";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Public, read-only retrieval of one published article including its full body.
 *
 * GET /api/posts/practical-guide-to-gatwick-transfers-from-brighton
 *
 * The listing endpoint returns summaries by default, so this is how a consuming
 * website renders an article page without over-fetching a whole listing. Each
 * listing item carries its own `content_url` pointing here.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const candidate = slug.trim().toLowerCase();

  if (candidate.length > 120 || !SLUG.test(candidate)) {
    return apiError(
      "post_not_found",
      "No published article matches that slug.",
      404,
    );
  }

  let post;

  try {
    post = await getPublishedPost(candidate);
  } catch (error) {
    console.error(
      "post_fetch_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return apiError(
      "server_error",
      "Could not load the article. Please retry shortly.",
      500,
    );
  }

  if (!post) {
    // A draft, a failed-quality article and a slug that never existed are
    // deliberately indistinguishable from outside.
    return apiError(
      "post_not_found",
      "No published article matches that slug.",
      404,
      { slug: candidate },
    );
  }

  return NextResponse.json(
    { data: post },
    { headers: { "Cache-Control": PUBLISHED_CACHE_CONTROL } },
  );
}
