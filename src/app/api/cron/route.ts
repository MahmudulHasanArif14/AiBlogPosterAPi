import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOCATION_ORDER = [
  "brighton",
  "london",
  "east-grinstead",
  "horley",
  "crawley",
  "horsham",
  "lewes",
  "haywards-heath",
  "gatwick",
  "worthing",
  "reigate",
  "lingfield",
  "falmer",
];

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const base = (process.env.SITE_URL || "").replace(/\/$/, "");

  if (!base) {
    return NextResponse.json(
      { error: "SITE_URL must be configured before scheduling" },
      { status: 500 },
    );
  }

  const db = supabaseAdmin();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Reuse today's job instead of inserting another one.
  const { data: todaysJob, error: todayError } = await db
    .from("generation_jobs")
    .select("id,status,location_id,topic")
    .eq("scheduled_day_utc", today)
    .maybeSingle();

  if (todayError) {
    console.error("Daily job lookup failed:", todayError.message);
    return NextResponse.json(
      { error: "Could not check today's schedule" },
      { status: 500 },
    );
  }

  let job = todaysJob;

  // If yesterday's job failed or was interrupted, retry that same job.
  // Move its scheduled date to today so it occupies today's single slot.
  if (!job) {
    const { data: unfinished, error: unfinishedError } = await db
      .from("generation_jobs")
      .select("id,status,location_id,topic,scheduled_for")
      .in("status", ["queued", "failed", "processing"])
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (unfinishedError) {
      console.error("Unfinished job lookup failed:", unfinishedError.message);
      return NextResponse.json(
        { error: "Could not check unfinished jobs" },
        { status: 500 },
      );
    }

    if (unfinished) {
      const { data: movedJob, error: moveError } = await db
        .from("generation_jobs")
        .update({ scheduled_for: now.toISOString() })
        .eq("id", unfinished.id)
        .select("id,status,location_id,topic")
        .single();

      if (moveError || !movedJob) {
        console.error("Retry scheduling failed:", moveError?.message);
        return NextResponse.json(
          { error: "Could not reschedule the existing job" },
          { status: 500 },
        );
      }

      job = movedJob;
    }
  }

  // Only create a new job if there is no job to retry and none today.
  if (!job) {
    const { data: locations, error: locationsError } = await db
      .from("locations")
      .select("id,name,slug")
      .eq("enabled", true);

    if (locationsError || !locations?.length) {
      console.error(
        "Enabled locations lookup failed:",
        locationsError?.message,
      );
      return NextResponse.json(
        { error: "No enabled locations available" },
        { status: 500 },
      );
    }

    const orderedLocations = LOCATION_ORDER.map((slug) =>
      locations.find((location) => location.slug === slug),
    ).filter((location) => location !== undefined);

    if (!orderedLocations.length) {
      return NextResponse.json(
        { error: "No enabled locations match the configured rotation" },
        { status: 500 },
      );
    }

    const { data: previousJobs, error: previousError } = await db
      .from("generation_jobs")
      .select("location_id,scheduled_for")
      .order("scheduled_for", { ascending: false })
      .limit(1);

    if (previousError) {
      console.error("Previous job lookup failed:", previousError.message);
      return NextResponse.json(
        { error: "Could not determine the next location" },
        { status: 500 },
      );
    }

    const previousLocationId = previousJobs?.[0]?.location_id;
    const previousIndex = orderedLocations.findIndex(
      (location) => location.id === previousLocationId,
    );

    const nextIndex =
      previousIndex < 0 ? 0 : (previousIndex + 1) % orderedLocations.length;

    const location = orderedLocations[nextIndex];

    const topic =
      `Create a fresh, original article for ${location.name} about taxi travel or local transport. ` +
      "Choose a specific reader question or practical angle yourself. " +
      "Avoid repeating the main angle of recent published articles. " +
      "Never invent fares, services, opening times, statistics, or unsupported claims.";

    const { data: newJob, error: insertError } = await db
      .from("generation_jobs")
      .insert({
        location_id: location.id,
        topic,
        status: "queued",
        scheduled_for: now.toISOString(),
      })
      .select("id,status,location_id,topic")
      .single();

    if (insertError || !newJob) {
      // A concurrent cron request may have won the daily unique-index race.
      if (insertError?.code === "23505") {
        return NextResponse.json({
          ok: true,
          message: "Another cron request already reserved today's job",
        });
      }

      console.error("Daily job insert failed:", insertError?.message);
      return NextResponse.json(
        { error: "Could not schedule today's article" },
        { status: 500 },
      );
    }

    job = newJob;
  }

  if (job.status === "completed") {
    return NextResponse.json({
      ok: true,
      message: "Today's job is already completed",
      jobId: job.id,
      status: job.status,
    });
  }

  const { data: location, error: locationError } = await db
    .from("locations")
    .select("slug,name,enabled")
    .eq("id", job.location_id)
    .maybeSingle();

  if (locationError || !location || !location.enabled) {
    return NextResponse.json(
      { error: "The job's location is missing or disabled", jobId: job.id },
      { status: 500 },
    );
  }

  // The generation route atomically claims this job before doing any AI work.
  const response = await fetch(`${base}/api/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationSlug: location.slug,
      topic: job.topic,
      jobId: job.id,
    }),
    signal: AbortSignal.timeout(95000),
  }).catch(() => null);

  // Do not mark a timed-out request failed here: generation may still be running.
  // The job-claim lease allows safe recovery if it becomes abandoned.
  if (!response) {
    return NextResponse.json(
      {
        ok: true,
        message:
          "Generation request timed out or disconnected; job retained for safe recovery",
        jobId: job.id,
        location: location.slug,
      },
      { status: 202 },
    );
  }

  const result = await response.json().catch(() => ({}));

  if (response.status === 202 || response.status === 409) {
    return NextResponse.json(
      {
        ok: true,
        message: "Job is already being processed or needs another retry",
        jobId: job.id,
        location: location.slug,
        result,
      },
      { status: 202 },
    );
  }

  if (!response.ok) {
    return NextResponse.json(
      {
        ok: false,
        message: "Generation did not complete; the job is retained for retry",
        jobId: job.id,
        location: location.slug,
        result,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    jobId: job.id,
    location: location.slug,
    result,
  });
}
