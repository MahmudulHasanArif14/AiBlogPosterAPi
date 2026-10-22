import { NextRequest, NextResponse } from "next/server";
import { runGenerationJob } from "@/lib/generation";
import { PLATFORM_TIMEZONE } from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A revision cycle cannot run inside a 60-second function: one provider call
// alone costs 60-115 seconds. This route therefore produces or re-evaluates a
// single draft and leaves any revision to the scheduled worker, which has no
// such ceiling.
const ROUTE_CYCLE_BUDGET_MS = 50_000;



/**
 * One scheduled article per day, platform-wide, rotating through the enabled
 * locations.
 *
 * Timezone handling: Vercel triggers crons on a UTC schedule, so the schedule
 * in vercel.json is a UTC trigger while the *slot* is keyed on the Europe/London
 * calendar date, computed in Postgres. A 03:00 UTC trigger is 03:00 GMT or
 * 04:00 BST, both comfortably inside the same London day, so a daylight-saving
 * transition cannot produce two slots for one London day or skip one.
 *
 * Order of work:
 *   1. Finish an unfinished earlier job first, so a location that failed keeps
 *      its turn instead of being skipped.
 *   2. Otherwise claim today's slot, atomically, via claim_daily_generation_slot.
 *   3. Generate inline. There is no internal HTTP hop: on the Hobby plan a
 *      function is killed at 60 seconds, so waiting on a second function's full
 *      budget could never complete.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  // Vercel sends the project's CRON_SECRET as a bearer token on scheduled
  // invocations, so the same check covers both the platform and an operator.
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();
  const now = new Date();

  // --- 1. Is an earlier scheduled job still owed an article? --------------

  const { data: unfinished, error: unfinishedError } = await db
    .from("generation_jobs")
    .select(
      "id,location_id,topic,status,attempts,max_attempts,next_attempt_at,scheduled_day_london",
    )
    .eq("kind", "scheduled")
    .in("status", ["queued", "failed", "processing"])
    .order("scheduled_for", { ascending: true })
    .limit(5);

  if (unfinishedError) {
    console.error("unfinished job lookup failed:", unfinishedError.message);

    return NextResponse.json(
      { error: "Could not check unfinished jobs", code: "server_error" },
      { status: 500 },
    );
  }

  const retryable = (unfinished ?? []).find(
    (job) =>
      job.attempts < job.max_attempts &&
      (!job.next_attempt_at || new Date(job.next_attempt_at) <= now),
  );

  if (retryable) {
    const { data: location } = await db
      .from("locations")
      .select("slug,name,enabled")
      .eq("id", retryable.location_id)
      .maybeSingle();

    if (!location || !location.enabled) {
      return NextResponse.json(
        {
          ok: false,
          message: "The unfinished job's location is missing or disabled",
          code: "location_unavailable",
          jobId: retryable.id,
        },
        { status: 500 },
      );
    }

    const outcome = await runGenerationJob({
      jobId: retryable.id,
      locationSlug: location.slug as string,
      topic: retryable.topic as string,
      budgetMs: ROUTE_CYCLE_BUDGET_MS,
    });

    return NextResponse.json(
      {
        ok: outcome.httpStatus < 400,
        mode: "retry_unfinished",
        jobId: retryable.id,
        location: location.slug,
        attempt: retryable.attempts + 1,
        maxAttempts: retryable.max_attempts,
        result: outcome.body,
      },
      { status: outcome.httpStatus < 400 ? 200 : 202 },
    );
  }

  // Jobs that are out of attempts or still cooling off are surfaced rather
  // than silently retried, so a persistent failure is visible in the logs.
  const waiting = (unfinished ?? []).filter(
    (job) =>
      job.attempts >= job.max_attempts ||
      (job.next_attempt_at && new Date(job.next_attempt_at) > now),
  );

  // --- 2. Claim today's slot ----------------------------------------------

  const { data: slot, error: slotError } = await db.rpc(
    "claim_daily_generation_slot",
    { p_now: now.toISOString(), p_timezone: PLATFORM_TIMEZONE },
  );

  if (slotError) {
    console.error("daily slot claim failed:", slotError.message);

    return NextResponse.json(
      { error: "Could not claim today's generation slot", code: "server_error" },
      { status: 500 },
    );
  }

  const claim = slot as Record<string, unknown> | null;

  if (!claim || claim.error) {
    return NextResponse.json(
      {
        error: "No enabled locations are available to schedule",
        code: "no_enabled_locations",
      },
      { status: 500 },
    );
  }

  if (claim.status === "completed") {
    return NextResponse.json({
      ok: true,
      message: "Today's article has already been generated",
      mode: "already_done",
      scheduledDay: claim.scheduledDay,
      timezone: PLATFORM_TIMEZONE,
      jobId: claim.jobId,
      location: claim.locationSlug,
      deferred: waiting.map((job) => job.id),
    });
  }

  if (claim.status === "exhausted") {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Today's job has used all of its attempts and needs manual review",
        mode: "exhausted",
        jobId: claim.jobId,
        location: claim.locationSlug,
        attempts: claim.attempts,
        maxAttempts: claim.maxAttempts,
      },
      { status: 202 },
    );
  }

  if (!claim.locationEnabled) {
    return NextResponse.json(
      {
        ok: false,
        message: "Today's job points at a location that is now disabled",
        code: "location_unavailable",
        jobId: claim.jobId,
      },
      { status: 500 },
    );
  }

  // --- 3. Generate ---------------------------------------------------------

  const outcome = await runGenerationJob({
    jobId: claim.jobId as string,
    locationSlug: claim.locationSlug as string,
    topic: claim.topic as string,
    budgetMs: ROUTE_CYCLE_BUDGET_MS,
  });

  return NextResponse.json(
    {
      ok: outcome.httpStatus < 400,
      mode: claim.createdNew ? "new_slot" : "resume_slot",
      scheduledDay: claim.scheduledDay,
      timezone: PLATFORM_TIMEZONE,
      jobId: claim.jobId,
      location: claim.locationSlug,
      result: outcome.body,
      deferred: waiting.map((job) => job.id),
    },
    { status: outcome.httpStatus < 400 ? 200 : 202 },
  );
}
