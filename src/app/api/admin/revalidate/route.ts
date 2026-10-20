import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { LOCATIONS_CACHE_TAG, POSTS_CACHE_TAG } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Clear the cached content listings.
 *
 * The scheduled worker runs outside Next, so it cannot call revalidateTag
 * itself. It posts here after publishing instead.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  revalidateTag(POSTS_CACHE_TAG);
  revalidateTag(LOCATIONS_CACHE_TAG);

  return NextResponse.json({
    revalidated: [POSTS_CACHE_TAG, LOCATIONS_CACHE_TAG],
    at: new Date().toISOString(),
  });
}
