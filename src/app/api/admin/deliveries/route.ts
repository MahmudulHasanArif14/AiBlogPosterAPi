import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { configuredTargets } from "@/lib/delivery";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Operational view of content distribution.
 *
 * GET  /api/admin/deliveries        — queue state, per-location configuration
 * POST /api/admin/deliveries        — reopen a dead delivery for another try
 *
 * Deliberately does not return webhook secrets, only whether each location has
 * one configured. There is no endpoint anywhere in this platform that reads a
 * signing secret back out.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();

  const { data: locations, error: locationError } = await db
    .from("locations")
    .select("slug,enabled")
    .eq("enabled", true)
    .order("slug");

  if (locationError) {
    return NextResponse.json(
      { error: "Could not read locations", code: "server_error" },
      { status: 500 },
    );
  }

  const slugs = (locations ?? []).map((row) => row.slug as string);
  const { targets, skipped } = configuredTargets(slugs);

  const { data: health } = await db.rpc("delivery_health", {
    p_now: new Date().toISOString(),
  });

  const { data: recent, error: recentError } = await db
    .from("content_deliveries")
    .select(
      "id,event,status,attempts,max_attempts,next_attempt_at,delivered_at,last_error,last_status_code,origin,created_at,posts(slug,title),locations(slug)",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  if (recentError) {
    return NextResponse.json(
      { error: "Could not read the delivery queue", code: "server_error" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    health: health ?? null,
    endpoints: {
      // Which websites can actually be notified right now. A location with no
      // website yet is expected to appear under `unconfigured`.
      configured: targets.map((target) => ({
        location: target.locationSlug,
        // Origin only. The full URL may carry a path a reader does not need,
        // and this keeps the response safe to paste into a ticket.
        origin: new URL(target.url).origin,
        hasSecret: true,
      })),
      unconfigured: skipped,
    },
    recent: recent ?? [],
  });
}

const ReplaySchema = z.object({
  /** The delivery to reopen. */
  deliveryId: z.string().uuid(),
  /**
   * Extra attempts to grant. A dead row is dead because it used its budget;
   * reopening it without raising the ceiling would do nothing.
   */
  extraAttempts: z.number().int().min(1).max(10).default(3),
});

/**
 * Reopen a dead delivery.
 *
 * This is the manual lever for "the website was down all weekend and the
 * delivery gave up". It does not re-send anything itself: it makes the row due
 * again and the next scheduled pass sends it, so the same signing, timeout and
 * backoff rules apply as to any other attempt.
 *
 * It cannot be used to distribute an unpublished article: the row's post is
 * re-checked at claim time, and a post that is no longer published is skipped.
 */
export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const parsed = ReplaySchema.safeParse(await req.json().catch(() => null));

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

  const { deliveryId, extraAttempts } = parsed.data;
  const db = supabaseAdmin();

  const { data: row, error: loadError } = await db
    .from("content_deliveries")
    .select("id,status,attempts,max_attempts")
    .eq("id", deliveryId)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json(
      { error: "Could not load the delivery", code: "server_error" },
      { status: 500 },
    );
  }

  if (!row) {
    return NextResponse.json(
      { error: "No delivery has that id", code: "delivery_not_found" },
      { status: 404 },
    );
  }

  if (row.status === "delivered") {
    return NextResponse.json(
      {
        error:
          "That delivery already succeeded. Re-sending it would announce the same publication twice.",
        code: "already_delivered",
      },
      { status: 409 },
    );
  }

  const { data: updated, error: updateError } = await db
    .from("content_deliveries")
    .update({
      status: "queued",
      max_attempts: (row.max_attempts as number) + extraAttempts,
      next_attempt_at: new Date().toISOString(),
      leased_until: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId)
    .select("id,status,attempts,max_attempts,next_attempt_at")
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Could not reopen the delivery", code: "server_error" },
      { status: 500 },
    );
  }

  await db.from("activity_log").insert({
    action: "delivery_reopened",
    entity_type: "content_delivery",
    entity_id: deliveryId,
    details: {
      previous_status: row.status,
      attempts: row.attempts,
      max_attempts: updated.max_attempts,
    },
  });

  return NextResponse.json({
    delivery: updated,
    note: "Queued. The next scheduled delivery pass will attempt it.",
  });
}
