import { NextResponse } from "next/server";
import { PUBLISHED_CACHE_CONTROL, apiError } from "@/lib/api-response";
import { listLocations } from "@/lib/posts-repository";

export const dynamic = "force-dynamic";

/**
 * Public, read-only list of the location slugs the content API accepts.
 *
 * GET /api/locations
 *
 * Consuming websites use this to validate their own configured slug at build
 * time rather than discovering a typo as an empty blog listing.
 */
export async function GET() {
  let locations;

  try {
    locations = await listLocations();
  } catch (error) {
    console.error(
      "locations_list_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return apiError(
      "server_error",
      "Could not load locations. Please retry shortly.",
      500,
    );
  }

  return NextResponse.json(
    { data: locations, total: locations.length },
    { headers: { "Cache-Control": PUBLISHED_CACHE_CONTROL } },
  );
}
