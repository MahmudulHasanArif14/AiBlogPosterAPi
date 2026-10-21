import { NextRequest, NextResponse } from "next/server";
import {
  RECONCILE_BATCH_SIZE,
  RECONCILE_WINDOW_HOURS,
  dispatchDueDeliveries,
  reconcileMissedDeliveries,
} from "@/lib/delivery";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The scheduled distribution task. Runs every 5-15 minutes.
 *
 * Two phases, in this order:
 *
 *   1. Reconcile. Find published articles that have no delivery row and create
 *      one. This is what recovers a webhook that was never enqueued because
 *      the publish-path insert failed, and it is an anti-join rather than a
 *      stored cursor, so a failed request can never advance progress past an
 *      article. See RECONCILE_WINDOW_HOURS for why the window is much wider
 *      than the schedule interval.
 *
 *   2. Dispatch. Claim every due delivery and attempt it. Claiming uses
 *      FOR UPDATE SKIP LOCKED under a lease, so two overlapping runs split the
 *      work instead of sending the same notification twice.
 *
 * Reconciling first means an article missed in this same interval is delivered
 * on this pass rather than the next one.
 *
 * Both phases are idempotent, so a duplicate invocation is harmless. That
 * matters because the scheduler is best-effort (see the scheduling note in
 * .github/workflows/deliver-content.yml): running twice is fine, and running
 * late only delays a notification, it does not lose one.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  // Vercel sends the project's CRON_SECRET as a bearer token on scheduled
  // invocations, so the same check covers the platform, the GitHub Actions
  // worker and an operator running it by hand.
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();
  const startedAt = Date.now();
  const now = new Date();

  // --- 1. Recover anything the publish path never enqueued -----------------

  let reconciled;

  try {
    reconciled = await reconcileMissedDeliveries(db, {
      windowHours: RECONCILE_WINDOW_HOURS,
      limit: RECONCILE_BATCH_SIZE,
      now,
    });
  } catch (error) {
    console.error(
      "delivery_reconcile_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    // Reconciliation failing must not stop dispatch: work already in the queue
    // is still owed to the websites. Reported, then carried on.
    reconciled = {
      since: null,
      windowHours: RECONCILE_WINDOW_HOURS,
      examined: 0,
      enqueued: [],
      error: error instanceof Error ? error.message : "unknown error",
    };
  }

  if (reconciled.enqueued.length > 0) {
    // Worth noticing: the articles still get through, but a non-empty result
    // means the immediate webhook path is not doing its job.
    console.warn(
      "delivery_reconcile_recovered:",
      reconciled.enqueued.length,
      reconciled.enqueued.map((row) => `${row.location_slug}/${row.post_slug}`),
    );
  }

  // --- 2. Send what is due -------------------------------------------------

  let dispatched;

  try {
    dispatched = await dispatchDueDeliveries(db, { now });
  } catch (error) {
    console.error(
      "delivery_dispatch_failed:",
      error instanceof Error ? error.message : "unknown error",
    );

    return NextResponse.json(
      {
        ok: false,
        error: "Could not dispatch deliveries",
        code: "dispatch_failed",
        reconciled,
      },
      { status: 500 },
    );
  }

  // --- 3. Queue health -----------------------------------------------------

  const { data: health } = await db.rpc("delivery_health", {
    p_now: new Date().toISOString(),
  });

  // A 200 here means "the task ran", not "every website accepted". An
  // individual failed delivery is normal and is retried; it must not make the
  // scheduler look broken.
  return NextResponse.json({
    ok: true,
    at: now.toISOString(),
    durationMs: Date.now() - startedAt,
    reconciled: {
      since: reconciled.since,
      windowHours: reconciled.windowHours,
      recovered: reconciled.enqueued.length,
      posts: reconciled.enqueued.map(
        (row) => `${row.location_slug}/${row.post_slug}`,
      ),
      ...("error" in reconciled && reconciled.error
        ? { error: reconciled.error }
        : {}),
    },
    dispatched,
    health: health ?? null,
  });
}

/** POST is accepted too, so the task can be triggered by anything convenient. */
export const POST = GET;
