import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import {
  LOCATIONS_CACHE_TAG,
  POSTS_CACHE_TAG,
  siteUrl,
} from "@/lib/config";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The database trigger refuses `published` while quality_reasons is non-empty
// or quality_score is below this, so a human decision has to clear them
// explicitly rather than nudging the status column.
const PUBLISH_SCORE = 85;

const RequestSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(120),
  action: z.enum(["publish", "reject"]),
  /**
   * For publish: the exact set of blocking reasons being overridden. It must
   * match what is actually on the row, so an article cannot be waved through
   * for a reason nobody looked at.
   */
  acknowledge: z.array(z.string().trim().min(1)).max(20).default([]),
  note: z.string().trim().max(1000).optional(),
  reviewer: z.string().trim().max(120).optional(),
});

function authorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

const REVIEW_COLUMNS =
  "id,slug,title,status,quality_score,quality_reasons,verification_status,image_url,published_at,canonical_url,review_notes,location_id,created_at";

/** The review queue: everything held, with why. */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      { error: "Unauthorized", code: "unauthorized" },
      { status: 401 },
    );
  }

  const db = supabaseAdmin();

  const { data, error } = await db
    .from("posts")
    .select(`${REVIEW_COLUMNS},locations(slug,name)`)
    .in("status", ["needs_review", "draft", "failed"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("review_queue_failed:", error.message);

    return NextResponse.json(
      { error: "Could not read the review queue", code: "server_error" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    total: data?.length ?? 0,
    data: (data ?? []).map((row) => ({
      ...row,
      // Spell out what publishing would require, so the caller does not have
      // to know the trigger's rules.
      publishable:
        row.verification_status !== "failed" &&
        (row.quality_reasons as string[] | null)?.length === 0,
      mustAcknowledge: (row.quality_reasons as string[] | null) ?? [],
    })),
  });
}

/**
 * Record a human review decision on a held article.
 *
 * This is the only sanctioned way to publish something the gate held. A direct
 * `UPDATE posts SET status = 'published'` is refused by the trigger, which is
 * deliberate: publication has to be a decision someone took, with the reasons
 * they overrode written down.
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

  const { slug, action, acknowledge, note, reviewer } = parsed.data;
  const db = supabaseAdmin();

  const { data: post, error: loadError } = await db
    .from("posts")
    .select(REVIEW_COLUMNS)
    .eq("slug", slug)
    .maybeSingle();

  if (loadError) {
    return NextResponse.json(
      { error: "Could not load the article", code: "server_error" },
      { status: 500 },
    );
  }

  if (!post) {
    return NextResponse.json(
      { error: `No article has the slug '${slug}'`, code: "post_not_found" },
      { status: 404 },
    );
  }

  const reasons = ((post.quality_reasons as string[] | null) ?? []).slice().sort();
  const stamp = new Date().toISOString();
  const by = reviewer ?? "operator";

  if (action === "reject") {
    const { error } = await db
      .from("posts")
      .update({
        status: "failed",
        published_at: null,
        canonical_url: null,
        review_notes: [
          post.review_notes,
          `Rejected by ${by} at ${stamp}.${note ? ` Note: ${note}` : ""}`,
        ]
          .filter(Boolean)
          .join("\n"),
      })
      .eq("id", post.id);

    if (error) {
      console.error("review_reject_failed:", error.message);

      return NextResponse.json(
        { error: "Could not reject the article", code: "server_error" },
        { status: 500 },
      );
    }

    await db.from("activity_log").insert({
      action: "manually_rejected",
      entity_type: "post",
      entity_id: post.id,
      details: { slug, reviewer: by, note: note ?? null, reasons },
    });

    return NextResponse.json({ slug, status: "failed", rejected: true });
  }

  // --- publish ------------------------------------------------------------

  if (post.status === "published") {
    return NextResponse.json(
      { error: "That article is already published", code: "already_published", slug },
      { status: 409 },
    );
  }

  // The one line a human override does not cross. A failed provenance check
  // means the article cites something dead or unapproved, and no amount of
  // reviewer confidence makes that citation good.
  if (post.verification_status === "failed") {
    return NextResponse.json(
      {
        error:
          "This article's source verification failed, so it cannot be published. Fix the citations and regenerate.",
        code: "verification_failed",
        slug,
      },
      { status: 422 },
    );
  }

  const acknowledged = acknowledge.slice().sort();
  const matches =
    reasons.length === acknowledged.length &&
    reasons.every((reason, index) => reason === acknowledged[index]);

  if (!matches) {
    return NextResponse.json(
      {
        error:
          "The acknowledged reasons do not match this article's blocking reasons. Re-read them and send the exact set.",
        code: "acknowledgement_mismatch",
        slug,
        blockingReasons: reasons,
        received: acknowledged,
        reviewNotes: post.review_notes,
      },
      { status: 409 },
    );
  }

  const base = siteUrl();

  const { data: updated, error: publishError } = await db
    .from("posts")
    .update({
      status: "published",
      published_at: post.published_at ?? stamp,
      canonical_url: post.canonical_url ?? `${base}/posts/${post.slug}`,
      // Cleared so the trigger allows publication. The original values are
      // preserved in review_notes and activity_log, so the override stays
      // auditable rather than erasing what the gate found.
      quality_reasons: [],
      quality_score: Math.max(
        (post.quality_score as number | null) ?? 0,
        PUBLISH_SCORE,
      ),
      review_notes: [
        post.review_notes,
        `Published by manual review (${by}) at ${stamp}.`,
        reasons.length > 0
          ? `Overrode gate reasons: ${reasons.join(", ")}. Original score: ${
              post.quality_score ?? "unknown"
            }.`
          : "Gate had no blocking reasons; publication was held only by policy.",
        note ? `Note: ${note}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    })
    .eq("id", post.id)
    .select("id,slug,title,status,published_at,canonical_url")
    .single();

  if (publishError || !updated) {
    console.error("review_publish_failed:", publishError?.message);

    return NextResponse.json(
      {
        error:
          "Could not publish the article. The database refused the change; check that its title, excerpt, body and meta description are all long enough.",
        code: "publish_rejected",
        detail: publishError?.message,
      },
      { status: 422 },
    );
  }

  await db.from("activity_log").insert({
    action: "manually_published",
    entity_type: "post",
    entity_id: post.id,
    details: {
      slug,
      reviewer: by,
      note: note ?? null,
      overrode_reasons: reasons,
      original_quality_score: post.quality_score,
      verification_status: post.verification_status,
    },
  });

  revalidateTag(POSTS_CACHE_TAG);
  revalidateTag(LOCATIONS_CACHE_TAG);

  return NextResponse.json({
    slug: updated.slug,
    status: updated.status,
    published_at: updated.published_at,
    url: updated.canonical_url,
    overrodeReasons: reasons,
  });
}
