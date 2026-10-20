import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runGenerationJob } from "@/lib/generation";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RequestSchema = z.object({
  locationSlug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  topic: z.string().trim().min(10).max(600).optional(),
  /** Generate immediately rather than leaving the job queued. */
  run: z.boolean().default(true),
});

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Operator-initiated generation for one location, outside the daily rotation.
 *
 * Jobs created here are kind='manual', which keeps them clear of the partial
 * unique index that reserves one 'scheduled' job per London day. Backfilling
 * initial content therefore cannot consume or disturb the daily cron slot, and
 * the rotation cursor is left alone.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Invalid request",
        code: "invalid_request",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const { locationSlug, topic, run } = parsed.data;
  const db = supabaseAdmin();

  const { data: location, error: locationError } = await db
    .from("locations")
    .select("id,slug,name,enabled")
    .eq("slug", locationSlug)
    .maybeSingle();

  if (locationError || !location || !location.enabled) {
    return NextResponse.json(
      {
        error: `No enabled location matches the slug '${locationSlug}'`,
        code: "unknown_location",
      },
      { status: 404 },
    );
  }

  const resolvedTopic =
    topic ??
    `Write a fresh, original article for ${location.name} about local travel and transport. Choose one specific reader question and answer it properly.`;

  const { data: job, error: insertError } = await db
    .from("generation_jobs")
    .insert({
      location_id: location.id,
      topic: resolvedTopic,
      status: "queued",
      kind: "manual",
      scheduled_for: new Date().toISOString(),
      max_attempts: 3,
    })
    .select("id,status,kind,attempts,max_attempts")
    .single();

  if (insertError || !job) {
    console.error("manual_job_insert_failed:", insertError?.message);

    return NextResponse.json(
      { error: "Could not create the generation job", code: "server_error" },
      { status: 500 },
    );
  }

  if (!run) {
    return NextResponse.json(
      { job, location: location.slug, queued: true },
      { status: 201 },
    );
  }

  const outcome = await runGenerationJob({
    jobId: job.id as string,
    locationSlug: location.slug as string,
    topic: resolvedTopic,
  });

  return NextResponse.json(
    {
      jobId: job.id,
      location: location.slug,
      kind: "manual",
      result: outcome.body,
    },
    { status: outcome.httpStatus },
  );
}
