import { NextRequest, NextResponse } from "next/server";
import {
  PUBLISHED_CACHE_CONTROL,
  apiError,
  parseListQuery,
} from "@/lib/api-response";
import { listPublishedPosts } from "@/lib/posts-repository";

export const dynamic = "force-dynamic";

/**
 * Public, read-only listing of published articles.
 *
 * GET /api/posts?location=brighton&page=1&limit=10
 *
 * The original response keys (`data`, `page`, `limit`, `total`) are retained so
 * the already-deployed consumers keep working; pagination metadata and the
 * per-post fields consuming websites need are added alongside them.
 */
export async function GET(req: NextRequest) {
  const parsed = parseListQuery(req.nextUrl.searchParams);

  if (!parsed.ok) {
    return parsed.response;
  }

  const { location, page, limit, includeContent } = parsed.value;

  let result;

  try {
    result = await listPublishedPosts(location, page, limit, includeContent);
  } catch (error) {
    console.error(
      "posts_list_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return apiError(
      "server_error",
      "Could not load posts. Please retry shortly.",
      500,
    );
  }

  if ("notFound" in result) {
    return apiError(
      "unknown_location",
      `No enabled location matches the slug '${location}'. Call /api/locations for the supported list.`,
      404,
      { location },
    );
  }

  const totalPages = result.total === 0 ? 0 : Math.ceil(result.total / limit);

  return NextResponse.json(
    {
      data: result.posts,
      page,
      limit,
      total: result.total,
      totalPages,
      hasPreviousPage: page > 1,
      hasNextPage: page < totalPages,
      location: result.location,
      contentIncluded: includeContent,
    },
    { headers: { "Cache-Control": PUBLISHED_CACHE_CONTROL } },
  );
}
