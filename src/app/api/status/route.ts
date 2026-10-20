import { NextRequest, NextResponse } from "next/server";
import { PLATFORM_TIMEZONE } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Operator view of the rotation and job health. Protected by CRON_SECRET,
 * because it exposes draft counts, failure reasons and the schedule.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();

  const [rotation, jobs, posts] = await Promise.all([
    db.rpc("rotation_status", {
      p_now: new Date().toISOString(),
      p_timezone: PLATFORM_TIMEZONE,
    }),
    db
      .from("generation_jobs")
      .select(
        "id,kind,status,attempts,max_attempts,last_error_code,error_message,scheduled_day_london,next_attempt_at,completed_at",
      )
      .order("scheduled_for", { ascending: false })
      .limit(20),
    db.from("posts").select("status"),
  ]);

  if (rotation.error || jobs.error || posts.error) {
    const detail =
      rotation.error?.message ?? jobs.error?.message ?? posts.error?.message;

    console.error("status_failed:", detail);

    return NextResponse.json(
      { error: "Could not read platform status", code: "server_error" },
      { status: 500 },
    );
  }

  const byStatus: Record<string, number> = {};

  for (const row of posts.data ?? []) {
    const key = row.status as string;
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }

  return NextResponse.json(
    {
      timezone: PLATFORM_TIMEZONE,
      autoPublishEnabled: process.env.AUTO_PUBLISH_ENABLED === "true",
      rotation: rotation.data,
      posts: { total: (posts.data ?? []).length, byStatus },
      recentJobs: jobs.data,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
