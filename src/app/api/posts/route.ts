import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
export const revalidate = 60;
export async function GET(req: NextRequest) {
  const location = req.nextUrl.searchParams.get("location");
  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") || 1));
  const limit = Math.min(
    20,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 10)),
  );
  const db = supabaseAdmin();
  let query = db
    .from("posts")
    .select(
      [
        "id",
        "title",
        "slug",
        "excerpt",
        "meta_description",
        "canonical_url",
        "published_at",
        "location_id",
        "image_url",
        "image_alt",
        "image_credit",
        "image_source_url",
        "image_provider",
        "image_mime",
        "image_width",
        "image_height",
        "image_license",
        "image_license_url",
      ].join(","),
      { count: "exact" },
    )
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (location) {
    const { data: loc } = await db
      .from("locations")
      .select("id")
      .eq("slug", location)
      .eq("enabled", true)
      .single();
    if (!loc)
      return NextResponse.json({ error: "Unknown location" }, { status: 404 });
    query = query.eq("location_id", loc.id);
  }
  const { data, error, count } = await query;
  if (error)
    return NextResponse.json(
      { error: "Could not load posts" },
      { status: 500 },
    );
  return NextResponse.json(
    { data: data || [], page, limit, total: count || 0 },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
