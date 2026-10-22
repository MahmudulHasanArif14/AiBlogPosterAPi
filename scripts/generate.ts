/**
 * Scheduled article worker.
 *
 * Generation needs 60-115 seconds against the configured reasoning model, which
 * does not fit Vercel's Hobby 60-second function limit. So the daily run lives
 * here and is driven by GitHub Actions, where there is no such ceiling. The
 * Vercel routes remain for short, operator-initiated work.
 *
 * Usage:
 *   tsx scripts/generate.ts --daily
 *   tsx scripts/generate.ts --location brighton [--topic "..."]
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * OPENROUTER_API_KEY, OPENROUTER_MODEL, PEXELS_API_KEY, SITE_URL.
 * Optional: AUTO_PUBLISH_ENABLED, AI_REQUEST_TIMEOUT_MS, CRON_SECRET.
 */

import {
  PLATFORM_TIMEZONE,
  QUALITY_CYCLE_BUDGET_MS,
  siteUrl,
} from "../src/lib/config";
import { runGenerationJob } from "../src/lib/generation";
import { supabaseAdmin } from "../src/lib/supabase";

type Args = { daily: boolean; seed: boolean; location?: string; topic?: string };

/**
 * The initial batch. Five different locations and five genuinely different
 * reader problems, so this is not one article with the place name swapped.
 * A location that already has a published article is skipped, which makes the
 * whole batch safe to re-run.
 */
const SEED_BATCH = [
  {
    locationSlug: "brighton",
    topic:
      "Arriving into Brighton Station for the first time: how to work out which onward option suits your group, your luggage and the time of day, and what to settle before you step off the train.",
  },
  {
    locationSlug: "gatwick",
    topic:
      "Meeting someone arriving at Gatwick Airport: how the two terminals differ for pick-ups, how to decide where to wait, and how to plan around a flight whose arrival time you cannot control.",
  },
  {
    locationSlug: "worthing",
    topic:
      "Travelling along the Sussex coast with heavy luggage, young children or reduced mobility: what to check about a station or route before you commit to it, and when a door-to-door option earns its cost.",
  },
  {
    locationSlug: "haywards-heath",
    topic:
      "Planning a very early or very late journey from Haywards Heath: how to work out whether public transport will actually be running, and what to arrange the night before so the plan does not depend on luck.",
  },
  {
    locationSlug: "crawley",
    topic:
      "Getting around Crawley and Three Bridges when the trains are disrupted: how to read what has actually happened, what the realistic alternatives are, and how to decide quickly rather than waiting on the platform.",
  },
];

function parseArgs(argv: string[]): Args {
  const args: Args = { daily: false, seed: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];

    if (flag === "--daily") {
      args.daily = true;
    } else if (flag === "--seed") {
      args.seed = true;
    } else if (flag === "--location") {
      args.location = argv[++i];
    } else if (flag === "--topic") {
      args.topic = argv[++i];
    }
  }

  return args;
}

function requireEnv() {
  const missing = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_MODEL",
    "PEXELS_API_KEY",
  ].filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}

/** Clear the hub's cached listings, which only a Next request context can do. */
async function revalidateHub() {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    console.warn(
      "CRON_SECRET not set: skipping cache revalidation. New articles will appear once the cache expires.",
    );
    return;
  }

  try {
    const res = await fetch(`${siteUrl()}/api/admin/revalidate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15_000),
    });

    console.log(`cache revalidation: HTTP ${res.status}`);
  } catch (error) {
    console.warn(
      "cache revalidation failed:",
      error instanceof Error ? error.message : "unknown error",
    );
  }
}

/**
 * An earlier scheduled job that is still owed a finished article: either it
 * never produced one, or its draft is below the quality bar and is waiting for
 * another revision cycle.
 *
 * This runs *before* today's slot and does not touch the rotation. Resuming a
 * draft must never consume a location's turn a second time -- the draft and its
 * failure details are stored on the article the job already owns.
 */
async function pendingRevisionTarget() {
  const db = supabaseAdmin();
  const now = new Date();

  const { data: unfinished, error: unfinishedError } = await db
    .from("generation_jobs")
    .select("id,location_id,topic,status,attempts,max_attempts,next_attempt_at")
    .eq("kind", "scheduled")
    .in("status", ["queued", "failed", "processing"])
    .order("scheduled_for", { ascending: true })
    .limit(5);

  if (unfinishedError) {
    throw new Error(`unfinished_lookup_failed: ${unfinishedError.message}`);
  }

  const retryable = (unfinished ?? []).find(
    (job) =>
      job.attempts < job.max_attempts &&
      (!job.next_attempt_at || new Date(job.next_attempt_at) <= now),
  );

  if (!retryable) {
    return null;
  }

  const { data: location } = await db
    .from("locations")
    .select("slug,enabled")
    .eq("id", retryable.location_id)
    .maybeSingle();

  if (!location?.enabled) {
    return null;
  }

  return {
    jobId: retryable.id as string,
    locationSlug: location.slug as string,
    topic: retryable.topic as string,
  };
}

async function claimDailySlot() {
  const db = supabaseAdmin();
  const now = new Date();

  const { data, error } = await db.rpc("claim_daily_generation_slot", {
    p_now: now.toISOString(),
    p_timezone: PLATFORM_TIMEZONE,
  });

  if (error) {
    throw new Error(`slot_claim_failed: ${error.message}`);
  }

  const claim = data as Record<string, unknown> | null;

  if (!claim || claim.error) {
    throw new Error(`slot_claim_failed: ${claim?.error ?? "no_result"}`);
  }

  if (claim.status === "completed") {
    return { mode: "already_done" as const, claim };
  }

  if (claim.status === "exhausted") {
    return { mode: "exhausted" as const, claim };
  }

  if (!claim.locationEnabled) {
    return { mode: "location_disabled" as const, claim };
  }

  return {
    mode: (claim.createdNew ? "new_slot" : "resume_slot") as
      | "new_slot"
      | "resume_slot",
    jobId: claim.jobId as string,
    locationSlug: claim.locationSlug as string,
    topic: claim.topic as string,
    claim,
  };
}

async function createManualJob(locationSlug: string, topic?: string) {
  const db = supabaseAdmin();

  const { data: location, error } = await db
    .from("locations")
    .select("id,slug,name,enabled")
    .eq("slug", locationSlug)
    .maybeSingle();

  if (error || !location || !location.enabled) {
    throw new Error(`unknown_or_disabled_location: ${locationSlug}`);
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
    .select("id")
    .single();

  if (insertError || !job) {
    throw new Error(`job_insert_failed: ${insertError?.message}`);
  }

  return {
    jobId: job.id as string,
    locationSlug: location.slug as string,
    topic: resolvedTopic,
  };
}

/** Print one generation outcome. Returns true if an article was published. */
function report(outcome: { httpStatus: number; body: Record<string, unknown> }, seconds: string) {
  const body = outcome.body as Record<string, unknown> & {
    post?: { title: string; slug: string; status: string };
    published?: boolean;
    retryable?: boolean;
    quality?: {
      score: number;
      pass: boolean;
      reasons: string[];
      warnings: string[];
      words: number;
      maxContentSimilarity: number;
    };
    verification?: { status: string };
    image?: { provider: string | null } | null;
  };

  console.log(`HTTP ${outcome.httpStatus} in ${seconds}s`);

  if (body.post) {
    console.log(`  title       : ${body.post.title}`);
    console.log(`  slug        : ${body.post.slug}`);
    console.log(`  status      : ${body.post.status}`);
    console.log(`  published   : ${body.published}`);
    console.log(`  quality     : score=${body.quality?.score} pass=${body.quality?.pass}`);

    if (body.quality?.reasons?.length) {
      console.log(`  BLOCKED BY  : ${body.quality.reasons.join(", ")}`);
    }

    if (body.quality?.warnings?.length) {
      console.log(`  warnings    : ${body.quality.warnings.join(", ")}`);
    }

    console.log(
      `  words       : ${body.quality?.words}  similarity=${body.quality?.maxContentSimilarity}`,
    );
    console.log(`  verification: ${body.verification?.status}`);
    console.log(`  image       : ${body.image ? body.image.provider : "none"}`);
  } else {
    console.log(`  ${JSON.stringify(body).slice(0, 800)}`);
  }

  return Boolean(body.published);
}

/** Locations that already have a published article, so seeding can skip them. */
async function locationsWithPublishedContent() {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("posts")
    .select("locations(slug)")
    .eq("status", "published");

  if (error) {
    throw new Error(`published_lookup_failed: ${error.message}`);
  }

  const slugs = new Set<string>();

  for (const row of data ?? []) {
    const location = (row as { locations?: { slug?: string } }).locations;

    if (location?.slug) {
      slugs.add(location.slug);
    }
  }

  return slugs;
}

async function runSeedBatch() {
  const alreadyCovered = await locationsWithPublishedContent();
  let published = 0;

  for (const item of SEED_BATCH) {
    console.log(`
=== ${item.locationSlug} ===`);

    if (alreadyCovered.has(item.locationSlug)) {
      console.log("  already has a published article; skipping");
      continue;
    }

    const started = Date.now();

    try {
      const target = await createManualJob(item.locationSlug, item.topic);
      const outcome = await runGenerationJob(target);

      if (report(outcome, ((Date.now() - started) / 1000).toFixed(1))) {
        published += 1;
      }
    } catch (error) {
      // One location failing must not abandon the rest of the batch.
      console.error(
        `  failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`
Seed batch complete: ${published} article(s) published.`);

  if (published > 0) {
    await revalidateHub();
  }

  if (published === 0) {
    console.error("No articles were published. See the per-location output above.");
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.daily && !args.seed && !args.location) {
    console.error(
      "Usage: tsx scripts/generate.ts --daily | --seed | --location <slug> [--topic <text>]",
    );
    process.exit(1);
  }

  requireEnv();

  if (args.seed) {
    await runSeedBatch();
    return;
  }

  const outcomes: { httpStatus: number; body: Record<string, unknown> }[] = [];
  let published = 0;
  let resumedJobId: string | null = null;

  // A --daily run can do two cycles -- resume a pending revision, then take
  // today's slot -- and both share one wall-clock budget. Giving each the full
  // QUALITY_CYCLE_BUDGET_MS would let a single run last twice that, which is
  // how the GitHub Actions job timeout gets hit and a job is killed still
  // marked `processing`.
  const runStartedAt = Date.now();
  const totalBudgetMs = QUALITY_CYCLE_BUDGET_MS;

  const budgetLeft = () =>
    Math.max(0, totalBudgetMs - (Date.now() - runStartedAt));

  const run = async (
    label: string,
    target: { jobId: string; locationSlug: string; topic: string },
  ) => {
    const started = Date.now();

    console.log(`
mode=${label} location=${target.locationSlug} job=${target.jobId} budgetMs=${budgetLeft()}`);

    const outcome = await runGenerationJob({ ...target, budgetMs: budgetLeft() });
    outcomes.push(outcome);

    if (report(outcome, ((Date.now() - started) / 1000).toFixed(1))) {
      published += 1;
    }
  };

  if (args.daily) {
    // 1. Resume a draft an earlier cycle left below the quality bar. This does
    //    not consume a rotation turn: it revises the article the job already
    //    owns, starting from that article's stored best-known draft.
    const pending = await pendingRevisionTarget();

    if (pending) {
      resumedJobId = pending.jobId;
      await run("resume_revision", pending);
    }

    // 2. Then take today's own slot, so a draft still in revision does not stop
    //    the platform publishing anything new. The slot is keyed on the London
    //    day, so this cannot produce a second article for the same day.
    const slot = await claimDailySlot();

    if (slot.mode === "already_done") {
      console.log("\nToday's article has already been generated.");
    } else if (slot.mode === "exhausted") {
      console.error(
        "\nToday's job has used all its attempts and needs manual review:",
        JSON.stringify(slot.claim),
      );
      process.exit(1);
    } else if (slot.mode === "location_disabled") {
      console.error(
        "\nToday's job points at a disabled location:",
        JSON.stringify(slot.claim),
      );
      process.exit(1);
    } else if (slot.jobId === resumedJobId) {
      // Today's slot *is* the job just revised. It is now waiting on its own
      // retry window, so running it again here would only hit the claim guard.
      console.log(
        "\nToday's slot is the job revised above; it resumes on the next cycle.",
      );
    } else {
      await run(slot.mode, slot);
    }
  } else {
    await run("manual", await createManualJob(args.location!, args.topic));
  }

  if (published > 0) {
    await revalidateHub();
  }

  // A retryable failure is not a red build: the job keeps its attempts, its
  // best draft is saved, and the next run resumes it. Only a failure nothing
  // can recover from should page anyone.
  const unrecoverable = outcomes.some((outcome) => {
    const body = outcome.body as { retryable?: boolean };
    return outcome.httpStatus >= 500 && !body.retryable;
  });

  if (unrecoverable) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Generation worker failed:");
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
