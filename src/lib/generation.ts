import { createHash } from "node:crypto";
import { z } from "zod";
import { ArticleSchema, readingMinutes } from "./article";
import { AI_REQUEST_TIMEOUT_MS, POSTS_CACHE_TAG, siteUrl } from "./config";
import { findWikimediaImage } from "./images/wikimedia";
import { checkQuality, type ApprovedSource } from "./quality";
import { supabaseAdmin } from "./supabase";
import { verifySources } from "./verification";

// The whole generation pipeline, callable from both the manual endpoint and the
// scheduled cron. It is deliberately a plain function rather than an internal
// HTTP call: this project runs on Vercel's Hobby plan, where a function is
// killed at 60 seconds, so a cron that waited on a second function's full
// request budget could never finish.

// The configured model is a reasoning model: it spends completion tokens
// thinking before it writes anything. At 4500 the entire budget went to
// reasoning and the response came back with finish_reason 'length' and an empty
// content string, which is what made every article fail validation. The budget
// has to cover reasoning *and* a 650-1000 word article.
//
// Measured: ~6000 reasoning + ~1300 content tokens, 60-115 seconds end to end.
// `reasoning: { effort: "low" }` made it *slower* (113s vs 58s unset), and
// `reasoning: { exclude: true }` only hides reasoning from the response without
// saving the tokens. Neither is used.
const AI_MAX_TOKENS = 10_000;

export type GenerationOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

export type GenerationInput = {
  jobId: string;
  locationSlug: string;
  topic: string;
};

const POST_RETURN_COLUMNS =
  "id,title,slug,status,published_at,canonical_url,image_url,image_source_url,image_license";

function contentHash(value: string) {
  const normalised = value.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

function buildSystemPrompt() {
  return [
    "You write accurate, genuinely useful UK local travel and taxi information.",
    "",
    "Return a single JSON object only, with these keys:",
    "  title, slug, excerpt, content, metaDescription, claims, sources, category, tags",
    "",
    "Hard rules:",
    "- content is plain text. No HTML, no markdown headings, no bullet characters.",
    "- content has at least four paragraphs separated by one blank line.",
    "- content is between 600 and 1200 words.",
    "- Never put a URL inside content. Cite sources only in the sources array.",
    "- sources must contain only URLs copied exactly from the approvedSources list you are given.",
    "- claims is an array of objects: { text, sourceUrl }. Declare EVERY statement in",
    "  the article that mentions money, a clock time, a duration, a distance, a",
    "  percentage, a statistic, a vehicle capacity, opening hours, a platform number,",
    "  or licensing and accessibility credentials. Each one needs a sourceUrl from",
    "  approvedSources that genuinely covers it.",
    "- Prefer writing with no specific numbers at all. A claim you cannot source must",
    "  be left out of the article entirely, not softened.",
    "- Never invent a station, airport, terminal or port. Only name real ones.",
    "- Never invent fares, timetables, company services, opening times, statistics,",
    "  testimonials, reviews, awards or legal claims.",
    "- Never make a superlative or guarantee claim about any operator: no cheapest,",
    "  best, fastest, award-winning, guaranteed fare, always on time, 100% reliable.",
    "- metaDescription is between 100 and 160 characters.",
    "- title is between 25 and 100 characters and must not repeat or closely",
    "  paraphrase any title in recentArticleTitles.",
    "- slug is lowercase, hyphen-separated, derived from the title.",
    "- excerpt is 60 to 240 characters and must not simply restate the title.",
    "- tags is up to six short lowercase topic tags. category is one short phrase.",
    "",
    "Write for a reader with a real problem to solve. Be specific and practical",
    "about choices, trade-offs and what to check before travelling. Do not write a",
    "doorway page, do not keyword-stuff the location name, and do not pad.",
  ].join("\n");
}

function buildUserPrompt(input: {
  locationName: string;
  topic: string;
  recentArticleTitles: string[];
  approvedSources: ApprovedSource[];
}) {
  return JSON.stringify({
    location: input.locationName,
    topicInstructions: input.topic,
    recentArticleTitles: input.recentArticleTitles,
    approvedSources: input.approvedSources.map((source) => ({
      name: source.sourceName,
      url: source.sourceUrl,
      coversWhat: source.notes,
    })),
    requirements:
      "Choose the specific subject and angle yourself, using the location and " +
      "topic instructions as context rather than as a fixed title. Pick one " +
      "concrete reader question and answer it properly. Avoid repeating the " +
      "angle of any recent article title listed above. Return only the JSON " +
      "object described in the system message.",
  });
}

export async function runGenerationJob(
  input: GenerationInput,
): Promise<GenerationOutcome> {
  const supabase = supabaseAdmin();
  const { jobId } = input;

  const failJob = async (code: string, message?: string) => {
    const { data, error } = await supabase.rpc("fail_generation_job", {
      p_job_id: jobId,
      p_code: code,
      p_message: message ?? code,
    });

    if (error) {
      console.error("could not record job failure:", error.message);
      return null;
    }

    return data as Record<string, unknown> | null;
  };

  // --- Location and job must agree ----------------------------------------

  const { data: loc, error: locError } = await supabase
    .from("locations")
    .select("id,name,slug,enabled")
    .eq("slug", input.locationSlug)
    .maybeSingle();

  if (locError || !loc || !loc.enabled) {
    return {
      httpStatus: 404,
      body: { error: "Location not found or disabled", code: "unknown_location" },
    };
  }

  const { data: job, error: jobError } = await supabase
    .from("generation_jobs")
    .select("id,location_id,status,attempts,max_attempts,kind")
    .eq("id", jobId)
    .maybeSingle();

  if (jobError || !job || job.location_id !== loc.id) {
    return {
      httpStatus: 404,
      body: {
        error: "Generation job not found or location mismatch",
        code: "job_not_found",
      },
    };
  }

  // --- Idempotency: one article per job, enforced by a unique index --------

  const { data: existingPost, error: existingError } = await supabase
    .from("posts")
    .select(POST_RETURN_COLUMNS)
    .eq("job_id", jobId)
    .maybeSingle();

  if (existingError) {
    return {
      httpStatus: 500,
      body: {
        error: "Could not check for an existing article",
        code: "server_error",
      },
    };
  }

  if (existingPost) {
    await supabase.rpc("complete_generation_job", {
      p_job_id: jobId,
      p_note: "recovered_existing_article",
    });

    return {
      httpStatus: 200,
      body: { post: existingPost, alreadyGenerated: true },
    };
  }

  // --- Atomic claim --------------------------------------------------------

  const { data: claimed, error: claimError } = await supabase.rpc(
    "claim_generation_job",
    { p_job_id: jobId },
  );

  if (claimError) {
    console.error("job claim failed:", claimError.message);

    return {
      httpStatus: 500,
      body: {
        error: "Could not safely claim generation job",
        code: "server_error",
      },
    };
  }

  if (!claimed) {
    return {
      httpStatus: 409,
      body: {
        error:
          "Job is already processing, is waiting for its retry window, or has exhausted its attempts",
        code: "job_not_claimable",
        jobId,
        attempts: job.attempts,
        maxAttempts: job.max_attempts,
      },
    };
  }

  // --- Context: approved sources and existing content ---------------------

  const [sourcesResult, titlesResult, contentsResult] = await Promise.all([
    supabase
      .from("content_sources")
      .select("source_name,source_url,notes")
      .eq("approved", true),
    supabase.from("posts").select("title,slug"),
    supabase
      .from("posts")
      .select("slug,content,location_id")
      .eq("location_id", loc.id)
      .order("created_at", { ascending: false })
      .limit(25),
  ]);

  if (sourcesResult.error || titlesResult.error || contentsResult.error) {
    const detail =
      sourcesResult.error?.message ??
      titlesResult.error?.message ??
      contentsResult.error?.message;

    console.error("generation context lookup failed:", detail);
    await failJob("context_lookup_failed", detail);

    return {
      httpStatus: 503,
      body: {
        error: "Could not load generation context safely",
        code: "server_error",
        retryable: true,
      },
    };
  }

  const approvedSources: ApprovedSource[] = (sourcesResult.data ?? []).map(
    (row) => ({
      sourceName: row.source_name as string,
      sourceUrl: (row.source_url as string | null) ?? null,
      notes: (row.notes as string | null) ?? "",
    }),
  );

  if (approvedSources.length === 0) {
    // Without approved sources nothing can be traced, so nothing could ever be
    // published. Fail loudly rather than generating unusable drafts.
    await failJob(
      "no_approved_sources",
      "content_sources has no approved rows; seed them before generating",
    );

    return {
      httpStatus: 503,
      body: {
        error:
          "No approved content sources are configured, so claims could not be traced",
        code: "no_approved_sources",
        retryable: true,
      },
    };
  }

  const existingTitles = (titlesResult.data ?? []).map(
    (row) => row.title as string,
  );
  const existingSlugs = (titlesResult.data ?? []).map(
    (row) => row.slug as string,
  );
  const existingContents = (contentsResult.data ?? []).map((row) => ({
    slug: row.slug as string,
    content: (row.content as string | null) ?? "",
  }));

  // --- Generate -----------------------------------------------------------

  const model = process.env.OPENROUTER_MODEL;
  const key = process.env.OPENROUTER_API_KEY;

  if (!model || !key) {
    await failJob("ai_provider_not_configured");

    return {
      httpStatus: 503,
      body: { error: "AI provider not configured", code: "provider_not_configured" },
    };
  }

  let aiResponse: Response;

  try {
    aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": siteUrl(),
        "X-Title": "Western Cars Content Hub",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: AI_MAX_TOKENS,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          {
            role: "user",
            content: buildUserPrompt({
              locationName: loc.name as string,
              topic: input.topic,
              recentArticleTitles: existingTitles.slice(0, 40),
              approvedSources,
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
  } catch {
    await failJob("provider_timeout");

    return {
      httpStatus: 503,
      body: {
        error: "Provider timeout; the job is retained for retry",
        code: "provider_timeout",
        retryable: true,
      },
    };
  }

  if (!aiResponse.ok) {
    const code =
      aiResponse.status === 429 ? "provider_rate_limit" : "provider_error";

    await failJob(code, `provider responded ${aiResponse.status}`);

    return {
      httpStatus: 503,
      body: {
        error:
          aiResponse.status === 429
            ? "Provider rate limit; the job is retained for retry"
            : "Provider error; the job is retained for retry",
        code,
        retryable: true,
      },
    };
  }

  const payload = await aiResponse.json().catch(() => null);
  const choice = payload?.choices?.[0];
  const raw = choice?.message?.content;
  const finishReason: string | undefined = choice?.finish_reason;
  const usage = payload?.usage;

  // A truncated response is a budget problem, not a bad article, and saying so
  // is the difference between a one-line fix and a long hunt. Reasoning models
  // hit this by thinking until the token budget is gone.
  if (finishReason === "length" && (typeof raw !== "string" || raw.trim() === "")) {
    const reasoningTokens =
      usage?.completion_tokens_details?.reasoning_tokens ?? "unknown";

    console.error(
      `provider_output_truncated: finish_reason=length, completion_tokens=${
        usage?.completion_tokens ?? "unknown"
      }, reasoning_tokens=${reasoningTokens}, max_tokens=${AI_MAX_TOKENS}`,
    );

    await failJob(
      "provider_output_truncated",
      `finish_reason=length reasoning_tokens=${reasoningTokens} max_tokens=${AI_MAX_TOKENS}`,
    );

    return {
      httpStatus: 503,
      body: {
        error:
          "The model used its whole token budget before writing the article. Raise max_tokens or lower the reasoning effort.",
        code: "provider_output_truncated",
        finishReason,
        reasoningTokens,
        retryable: true,
      },
    };
  }

  let article;

  try {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `provider returned no article content (finish_reason=${finishReason ?? "unknown"})`,
      );
    }

    article = ArticleSchema.parse(JSON.parse(raw));
  } catch (error) {
    const details =
      error instanceof z.ZodError
        ? error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          }))
        : undefined;

    console.error(
      `article validation failed (finish_reason=${finishReason ?? "unknown"}, completion_tokens=${
        usage?.completion_tokens ?? "unknown"
      }, content_length=${typeof raw === "string" ? raw.length : "n/a"}):`,
      details ?? error,
    );

    await failJob("invalid_article_structure", JSON.stringify(details ?? {}));

    return {
      httpStatus: 422,
      body: {
        error: "Invalid article structure",
        code: "invalid_article_structure",
        details,
        retryable: true,
      },
    };
  }

  // --- Quality gate -------------------------------------------------------

  const quality = checkQuality(article, {
    locationName: loc.name as string,
    existingTitles,
    existingSlugs,
    existingContents,
    approvedSources,
  });

  // --- Provenance check and featured image --------------------------------
  //
  // Both are network-bound and independent of each other, so they run together.
  // Sequentially they were the two slowest steps after generation, and the
  // whole handler has to finish inside 60 seconds.

  const declaredSourceUrls = [
    ...article.sources,
    ...article.claims
      .map((claim) => claim.sourceUrl)
      .filter((url): url is string => typeof url === "string"),
  ];

  const [verification, image] = await Promise.all([
    verifySources(declaredSourceUrls, approvedSources),
    findWikimediaImage(loc.name as string, article.title).catch((error) => {
      console.error("image lookup failed:", error);
      return null;
    }),
  ]);

  // --- Publication decision ------------------------------------------------

  const blocking = [...quality.reasons];

  if (!image) {
    blocking.push("image_not_verified");
  }

  if (verification.status !== "verified") {
    blocking.push(`verification_${verification.status}`);
  }

  const uniqueBlocking = [...new Set(blocking)];

  const autoPublishAllowed = process.env.AUTO_PUBLISH_ENABLED === "true";
  const publish = uniqueBlocking.length === 0 && autoPublishAllowed;

  if (uniqueBlocking.length === 0 && !autoPublishAllowed) {
    quality.warnings.push("auto_publish_disabled");
  }

  const base = siteUrl();
  const now = new Date().toISOString();

  const postData = {
    location_id: loc.id,
    job_id: jobId,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    content: article.content,
    meta_description: article.metaDescription,

    status: publish ? "published" : "needs_review",
    published_at: publish ? now : null,
    canonical_url: publish ? `${base}/posts/${article.slug}` : null,

    author: "Western Cars Content Team",
    category: article.category ?? null,
    tags: article.tags,
    reading_minutes: readingMinutes(article.content),
    content_hash: contentHash(article.content),

    // The score the database trigger checks must reflect everything blocking,
    // not just the text-level gate, or a missing image could slip through.
    quality_score: uniqueBlocking.length === 0 ? quality.score : Math.min(quality.score, 60),
    quality_reasons: uniqueBlocking,
    verification_status: verification.status,
    verified_claims: quality.details.verifiedClaims,
    source_urls: [...new Set(declaredSourceUrls)],
    review_notes:
      uniqueBlocking.length === 0
        ? null
        : [
            `Blocked by: ${uniqueBlocking.join(", ")}`,
            quality.details.undeclaredMaterialSentences.length > 0
              ? `Undeclared material sentences: ${JSON.stringify(
                  quality.details.undeclaredMaterialSentences,
                )}`
              : null,
            quality.details.unverifiedClaims.length > 0
              ? `Unverified claims: ${JSON.stringify(quality.details.unverifiedClaims)}`
              : null,
            quality.details.unrecognisedPlaces.length > 0
              ? `Unrecognised places: ${quality.details.unrecognisedPlaces.join(", ")}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),

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

  const { data: post, error: saveError } = await supabase
    .from("posts")
    .insert(postData)
    .select(POST_RETURN_COLUMNS)
    .single();

  if (saveError || !post) {
    console.error("article save failed:", saveError?.message);

    // A previous attempt may have saved the article before failing to report.
    const { data: recovered } = await supabase
      .from("posts")
      .select(POST_RETURN_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle();

    if (recovered) {
      await supabase.rpc("complete_generation_job", {
        p_job_id: jobId,
        p_note: "recovered_existing_article",
      });

      return {
        httpStatus: 200,
        body: { post: recovered, alreadyGenerated: true },
      };
    }

    // 23505 is a unique violation: a duplicate title or an identical body.
    const duplicate = saveError?.code === "23505";

    await failJob(
      duplicate ? "duplicate_article_rejected" : "article_save_failed",
      saveError?.message,
    );

    return {
      httpStatus: duplicate ? 409 : 503,
      body: {
        error: duplicate
          ? "The generated article duplicated an existing title or body and was rejected"
          : "Article save failed; the job is retained for retry",
        code: duplicate ? "duplicate_article" : "article_save_failed",
        retryable: true,
      },
    };
  }

  await supabase.rpc("complete_generation_job", {
    p_job_id: jobId,
    p_note:
      uniqueBlocking.length === 0 ? null : `quality:${uniqueBlocking.join(",")}`,
  });

  // Clear the cached listings so a newly published article is visible on the
  // next request rather than after the revalidate window. Outside a Next
  // request context -- the scheduled worker -- this is a no-op, and the worker
  // calls /api/admin/revalidate instead.
  if (publish) {
    try {
      const { revalidateTag } = await import("next/cache");
      revalidateTag(POSTS_CACHE_TAG);
    } catch {
      // Not running inside Next. Expected for the scheduled worker.
    }
  }

  const { error: activityError } = await supabase.from("activity_log").insert({
    action: publish ? "auto_published" : "generated_for_review",
    entity_type: "post",
    entity_id: post.id,
    details: {
      model,
      job_id: jobId,
      location: loc.slug,
      quality_score: postData.quality_score,
      quality_reasons: uniqueBlocking,
      quality_warnings: quality.warnings,
      words: quality.details.words,
      max_content_similarity: quality.details.maxContentSimilarity,
      verification_status: verification.status,
      verification_checks: verification.checks,
      verified_claim_count: quality.details.verifiedClaims.length,
      unverified_claims: quality.details.unverifiedClaims,
      unrecognised_places: quality.details.unrecognisedPlaces,
      undeclared_material_sentences: quality.details.undeclaredMaterialSentences,
      image_found: Boolean(image),
      image_provider: image?.image_provider ?? null,
      image_license: image?.image_license ?? null,
    },
  });

  if (activityError) {
    console.error("activity logging failed:", activityError.message);
  }

  return {
    httpStatus: 201,
    body: {
      post,
      published: publish,
      quality: {
        score: postData.quality_score,
        pass: uniqueBlocking.length === 0,
        reasons: uniqueBlocking,
        warnings: quality.warnings,
        words: quality.details.words,
        maxContentSimilarity: quality.details.maxContentSimilarity,
        unverifiedClaims: quality.details.unverifiedClaims,
        unrecognisedPlaces: quality.details.unrecognisedPlaces,
        undeclaredMaterialSentences: quality.details.undeclaredMaterialSentences,
      },
      verification,
      image: image
        ? {
            provider: image.image_provider,
            sourceUrl: image.image_source_url,
            license: image.image_license,
            licenseUrl: image.image_license_url,
          }
        : null,
    },
  };
}
