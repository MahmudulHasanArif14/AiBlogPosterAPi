import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ArticleSchema } from "@/lib/article";
import { checkQuality } from "@/lib/quality";
import { supabaseAdmin } from "@/lib/supabase";
import { findWikimediaImage } from "@/lib/images/wikimedia";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  locationSlug: z.string().min(2).max(80),
  topic: z.string().min(5).max(240),
  jobId: z.string().uuid(),
});

function cronAuthorized(req: NextRequest) {
  const secret = process.env.CRON_SECRET;

  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const supabase = supabaseAdmin();
  const input = parsed.data;
  const jobId = input.jobId;

  // Validate that the requested location exists and is enabled.
  const { data: loc, error: locErr } = await supabase
    .from("locations")
    .select("id,name,slug,enabled")
    .eq("slug", input.locationSlug)
    .maybeSingle();

  if (locErr || !loc || !loc.enabled) {
    return NextResponse.json(
      { error: "Location not found or disabled" },
      { status: 404 },
    );
  }

  // Verify that the job belongs to this location.
  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .select("id,location_id,status")
    .eq("id", jobId)
    .maybeSingle();

  if (jobError || !job || job.location_id !== loc.id) {
    return NextResponse.json(
      { error: "Generation job not found or location mismatch" },
      { status: 404 },
    );
  }

  // Shared failure handler for errors after the job is claimed.
  const failJob = async (message: string) => {
    const { error } = await supabase
      .from("generation_jobs")
      .update({
        status: "failed",
        error_message: message.slice(0, 500),
      })
      .eq("id", jobId)
      .eq("status", "processing");

    if (error) {
      console.error("Could not record job failure:", error.message);
    }
  };

  // Idempotency check: never generate a second article for a job
  // that already has an article saved.
  const { data: existingPost, error: existingPostError } = await supabase
    .from("posts")
    .select("id,title,slug,status,image_url,image_source_url,image_license")
    .eq("job_id", jobId)
    .maybeSingle();

  if (existingPostError) {
    return NextResponse.json(
      { error: "Could not check for an existing article" },
      { status: 500 },
    );
  }

  if (existingPost) {
    const { error: completeError } = await supabase
      .from("generation_jobs")
      .update({
        status: "completed",
        error_message: null,
      })
      .eq("id", jobId);

    if (completeError) {
      console.error(
        "Existing article found, but job completion update failed:",
        completeError.message,
      );

      return NextResponse.json(
        {
          error: "Article exists, but job recovery needs another retry",
          post: existingPost,
        },
        { status: 503 },
      );
    }

    return NextResponse.json(
      {
        post: existingPost,
        alreadyGenerated: true,
      },
      { status: 200 },
    );
  }

  // Atomically claim the job. Only one concurrent request should win.
  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_generation_job",
    { p_job_id: jobId },
  );

  if (claimError) {
    console.error("Job claim failed:", claimError.message);

    return NextResponse.json(
      { error: "Could not safely claim generation job" },
      { status: 500 },
    );
  }

  if (!claimed) {
    return NextResponse.json(
      {
        error: "Job is already processing or is not eligible for retry",
        jobId,
      },
      { status: 409 },
    );
  }

  // Load approved factual sources.
  const { data: sourceRows, error: sourceError } = await supabase
    .from("content_sources")
    .select("notes,source_name")
    .eq("approved", true);

  if (sourceError) {
    console.error("Approved sources lookup failed:", sourceError.message);
    await failJob("approved_sources_lookup_failed");

    return NextResponse.json(
      { error: "Could not load approved content sources" },
      { status: 500 },
    );
  }

  const facts = (sourceRows || [])
    .map((source) => `${source.source_name}: ${source.notes || ""}`)
    .filter(Boolean);

  // Load recent published titles to reduce repetitive topics.
  const { data: oldPosts, error: oldPostsError } = await supabase
    .from("posts")
    .select("title")
    .eq("location_id", loc.id)
    .eq("status", "published")
    .order("published_at", {
      ascending: false,
      nullsFirst: false,
    })
    .limit(40);

  if (oldPostsError) {
    console.error("Recent articles lookup failed:", oldPostsError.message);
    await failJob("recent_articles_lookup_failed");

    return NextResponse.json(
      { error: "Could not check recent articles safely" },
      { status: 500 },
    );
  }

  const recentArticleTitles = (oldPosts || []).map((post) => post.title);

  const model = process.env.OPENROUTER_MODEL;
  const key = process.env.OPENROUTER_API_KEY;

  if (!model || !key) {
    await failJob("ai_provider_not_configured");

    return NextResponse.json(
      { error: "AI provider not configured" },
      { status: 503 },
    );
  }

  // Generate a location-specific article using OpenRouter.
  let aiResponse: Response;

  try {
    aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.SITE_URL || "https://content.westerncars.co.uk",
        "X-Title": "Western Cars Content Hub",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        max_tokens: 4500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You write accurate, useful UK travel information. " +
              "Return JSON only with title, slug, excerpt, content, " +
              "metaDescription, and claims. Each claims entry must be " +
              "a material factual claim made in the article. Use only " +
              "the approved facts supplied. Never invent fares, company " +
              "services, opening times, statistics, testimonials or legal " +
              "claims. If facts are missing, avoid the claim. Write original, " +
              "helpful prose, not doorway pages or keyword stuffing. " +
              "Content must be plain text with paragraph breaks; do not " +
              "include HTML.",
          },
          {
            role: "user",
            content: JSON.stringify({
              location: loc.name,
              topicInstructions: input.topic,
              recentPublishedArticleTitles: recentArticleTitles,
              approvedFacts: facts,
              requirements:
                "Choose the article's specific subject and angle yourself. " +
                "Use the location and topic instructions as context, not as " +
                "a fixed title. Create a useful, specific, evergreen UK taxi " +
                "or local-transport article. Avoid repeating or closely " +
                "paraphrasing any recent published title or its main angle. " +
                "Explore a different reader question, journey-planning " +
                "problem, audience need, or practical situation. Do not " +
                "invent current events, fares, services, opening times, " +
                "statistics, testimonials, or legal claims. Only use approved " +
                "facts for factual claims. Do not claim a specific Western " +
                "Cars service or fare unless approved facts support it. " +
                "Return the required JSON article structure only.",
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(85000),
    });
  } catch {
    await failJob("provider_timeout");

    return NextResponse.json(
      { error: "Provider timeout; retry later", retryable: true },
      { status: 503 },
    );
  }

  if (!aiResponse.ok) {
    const reason =
      aiResponse.status === 429 ? "provider_rate_limit" : "provider_error";

    await failJob(reason);

    return NextResponse.json(
      {
        error:
          aiResponse.status === 429
            ? "Provider rate limit; retry later"
            : "Provider error; retry later",
        retryable: true,
      },
      { status: 503 },
    );
  }

  const payload = await aiResponse.json().catch(() => null);
  const raw = payload?.choices?.[0]?.message?.content;

  let article;

  try {
    if (typeof raw !== "string") {
      throw new Error("Provider returned no article content");
    }

    article = ArticleSchema.parse(JSON.parse(raw));
  } catch (error) {
    console.error(
      "Article validation failed:",
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
            code: issue.code,
          }))
        : error instanceof Error
          ? error.message
          : "Unknown error",
    );

    await failJob("invalid_article_structure");

    return NextResponse.json(
      {
        error: "Invalid article structure",
        details:
          error instanceof z.ZodError
            ? error.issues.map((issue) => ({
                field: issue.path.join("."),
                message: issue.message,
                code: issue.code,
              }))
            : undefined,
        retryable: true,
      },
      { status: 422 },
    );
  }

  // Evaluate the article against recent titles and approved facts.
  const quality = checkQuality(article, recentArticleTitles, facts);

  // Look up a licence-checked featured image.
  let image: Awaited<ReturnType<typeof findWikimediaImage>>;

  try {
    image = await findWikimediaImage(loc.name, article.title);
  } catch (error) {
    console.error("Image lookup failed:", error);
    await failJob("image_lookup_failed");

    return NextResponse.json(
      { error: "Image lookup failed; retry later", retryable: true },
      { status: 503 },
    );
  }

  // Missing image blocks automatic publication, but allows review.
  const finalQuality = image
    ? quality
    : {
        ...quality,
        pass: false,
        score: Math.min(quality.score, 65),
        reasons: [...new Set([...quality.reasons, "image_not_verified"])],
      };

  const autoPublish =
    finalQuality.pass &&
    image !== null &&
    process.env.AUTO_PUBLISH_ENABLED === "true";

  const base = (
    process.env.SITE_URL || "https://content.westerncars.co.uk"
  ).replace(/\/$/, "");

  const postData = {
    location_id: loc.id,
    job_id: jobId,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    content: article.content,
    meta_description: article.metaDescription,

    status: autoPublish ? "published" : "needs_review",
    published_at: autoPublish ? new Date().toISOString() : null,
    canonical_url: autoPublish ? `${base}/posts/${article.slug}` : null,

    image_url: image?.image_url ?? null,
    image_alt: image?.image_alt ?? null,
    image_credit: image?.image_credit ?? null,
    image_source_url: image?.image_source_url ?? null,
    image_provider: image?.image_provider ?? null,
    image_mime: image?.image_mime ?? null,
    image_width: image?.image_width ?? null,
    image_height: image?.image_height ?? null,
    image_license: image?.image_license ?? null,
    image_license_url: image?.image_license_url ?? null,
  };

  // The unique posts.job_id index is the database-level duplicate guard.
  const { data: post, error: saveError } = await supabase
    .from("posts")
    .insert(postData)
    .select("id,title,slug,status,image_url,image_source_url,image_license")
    .single();

  if (saveError || !post) {
    console.error("Article save failed:", saveError?.message);

    // A previous attempt may have saved the article before failing.
    const { data: recoveredPost, error: recoveryError } = await supabase
      .from("posts")
      .select("id,title,slug,status,image_url,image_source_url,image_license")
      .eq("job_id", jobId)
      .maybeSingle();

    if (!recoveryError && recoveredPost) {
      const { error: completeError } = await supabase
        .from("generation_jobs")
        .update({
          status: "completed",
          error_message: null,
        })
        .eq("id", jobId);

      if (!completeError) {
        return NextResponse.json(
          {
            post: recoveredPost,
            alreadyGenerated: true,
          },
          { status: 200 },
        );
      }
    }

    await failJob("article_save_failed");

    return NextResponse.json(
      {
        error: "Article save failed; job retained for retry",
        retryable: true,
      },
      { status: 503 },
    );
  }

  // Mark the job completed only after the article is safely saved.
  const { error: completeError } = await supabase
    .from("generation_jobs")
    .update({
      status: "completed",
      error_message: finalQuality.pass
        ? null
        : `quality:${finalQuality.reasons.join(",")}`,
    })
    .eq("id", jobId);

  if (completeError) {
    console.error(
      "Article saved, but job completion failed:",
      completeError.message,
    );

    // Leave the article saved. The next retry will discover it by job_id.
    return NextResponse.json(
      {
        post,
        warning: "Article saved; job completion will be recovered on retry",
      },
      { status: 202 },
    );
  }

  // Activity logging is secondary; it must not invalidate a saved article.
  const { error: activityError } = await supabase.from("activity_log").insert({
    action:
      post.status === "published" ? "auto_published" : "generated_for_review",
    entity_type: "post",
    entity_id: post.id,
    details: {
      quality_score: finalQuality.score,
      quality_reasons: finalQuality.reasons,
      model,
      image_found: Boolean(image),
      image_provider: image?.image_provider ?? null,
      image_license: image?.image_license ?? null,
    },
  });

  if (activityError) {
    console.error(
      "Article saved, but activity logging failed:",
      activityError.message,
    );
  }

  return NextResponse.json(
    {
      post,
      quality: finalQuality,
      image: image
        ? {
            provider: image.image_provider,
            sourceUrl: image.image_source_url,
            license: image.image_license,
            licenseUrl: image.image_license_url,
          }
        : null,
    },
    { status: 201 },
  );
}
