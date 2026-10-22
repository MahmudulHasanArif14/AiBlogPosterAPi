import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ARTICLE_JSON_SCHEMA,
  ArticleSchema,
  normaliseArticlePayload,
  readingMinutes,
  type Article,
} from "./article";
import {
  AI_MAX_TOKENS,
  AI_REQUEST_TIMEOUT_MS,
  MAX_ARTICLE_REVISION_AGE_HOURS,
  MIN_ARTICLE_QUALITY_SCORE,
  POSTS_CACHE_TAG,
  QUALITY_CYCLE_BUDGET_MS,
  siteUrl,
} from "./config";
import { enqueueDelivery } from "./delivery";
import { findWikimediaImage, type FeaturedImage } from "./images/wikimedia";
import { checkQuality, type ApprovedSource } from "./quality";
import {
  buildCorrectionInstructions,
  parseRetryAfter,
  runImprovementLoop,
  type AttemptLog,
  type DraftEvaluation,
  type LoopResult,
  type ProviderResult,
  type RevisionRequest,
} from "./revision";
import { supabaseAdmin } from "./supabase";
import { verifySources } from "./verification";
import { LOCATION_TOPICS, SHARED_TOPIC_ANGLES } from "@/lib/topics";

export type GenerationOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

export type GenerationInput = {
  jobId: string;
  locationSlug: string;
  topic: string;
  budgetMs?: number;
};

const POST_RETURN_COLUMNS =
  "id,title,slug,status,published_at,canonical_url,image_url,image_source_url,image_license";

const RESUME_SELECT =
  "id,title,slug,status,published_at,canonical_url,image_url,image_source_url,image_license,created_at,revision_count,provider_retry_count,best_quality_score,best_draft";

function contentHash(value: string) {
  const normalised = value.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex");
}

// TOPIC ANGLES: deterministically select an angle for a generation job.
// Retries and revisions for the same job retain the same selected angles.
function stablePick<T>(items: readonly T[], seed: string): T {
  if (items.length === 0) {
    throw new Error("Cannot select an angle from an empty list");
  }

  const hash = createHash("sha256").update(seed).digest();
  const index = hash.readUInt32BE(0) % items.length;

  return items[index]!;
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
    "- Use clear paragraphs separated by blank lines. Aim for 4–6 paragraphs,",
    "  each covering a distinct part of the reader's problem.",
    "- content is between 600 and 1200 words. Avoid padding.",
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
    "- metaDescription must be between 100 and 160 characters. Aim for 140-155",
    "  characters: 160 is a hard limit and overrunning it fails the article.",
    "  Count the characters before returning it.",
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

// TOPIC ANGLES: include both selected angles in the shared context so the
// initial generation and every revision receive the same instructions.
type PromptContext = {
  locationName: string;
  topic: string;
  topicAngle: string;
  sharedAngle: string;
  recentArticleTitles: string[];
  approvedSources: ApprovedSource[];
};

function serialiseSources(approvedSources: ApprovedSource[]) {
  return approvedSources.map((source) => ({
    name: source.sourceName,
    url: source.sourceUrl,
    coversWhat: source.notes,
  }));
}

// TOPIC ANGLES: the location-specific angle is the primary subject.
// The shared angle is supplementary, not a competing topic.
function buildUserPrompt(input: PromptContext) {
  return JSON.stringify({
    location: input.locationName,
    topicInstructions: input.topic,
    selectedLocationAngle: input.topicAngle,
    selectedSharedAngle: input.sharedAngle,
    recentArticleTitles: input.recentArticleTitles,
    approvedSources: serialiseSources(input.approvedSources),
    requirements:
      "Use selectedLocationAngle as the main subject and selectedSharedAngle " +
      "as a supporting approach where relevant. The location-specific angle " +
      "takes priority. Answer one concrete reader question with useful, " +
      "original information. Do not force the shared angle if it does not fit. " +
      "Avoid repeating recent article titles or their underlying subjects. " +
      "Use only facts supported by the approved sources. Return only the JSON " +
      "object described in the system message.",
  });
}

/**
 * The correction prompt carries the previous draft, failed checks and evidence
 * so revisions fix named weaknesses instead of re-rolling the article.
 *
 * It preserves the original slug and both selected topic angles.
 */
export function buildRevisionPrompt(
  request: RevisionRequest,
  context: PromptContext & { preserveSlug: string },
) {
  const { evaluation } = request;

  return JSON.stringify({
    task:
      "Improve the previous draft so it passes the named checks. Return the " +
      "complete corrected article as a single JSON object in exactly the same " +
      "schema as before — not a diff, not a commentary, not an explanation.",
    previousDraft: request.draft,
    failedChecks: request.failures,
    whatToFix: request.instructions,
    evidence: {
      score: evaluation.score,
      scoreRequired: MIN_ARTICLE_QUALITY_SCORE,
      advisoryWarnings: evaluation.quality.warnings,
      unsupportedClaims: evaluation.quality.details.unverifiedClaims,
      undeclaredMaterialSentences:
        evaluation.quality.details.undeclaredMaterialSentences,
      unrecognisedPlaces: evaluation.quality.details.unrecognisedPlaces,
      untrustedCitations: evaluation.quality.details.untrustedCitations,
      sourceChecks: evaluation.verification.checks.map((check) => ({
        url: check.url,
        outcome: check.outcome,
      })),
      wordCount: evaluation.quality.details.words,
      mostSimilarExistingArticle: evaluation.quality.details.mostSimilarSlug,
      licensedImageFound: evaluation.imageOk,
    },
    mustNotChange: {
      location: context.locationName,
      topicInstructions: context.topic,
      selectedLocationAngle: context.topicAngle,
      selectedSharedAngle: context.sharedAngle,
      slug: context.preserveSlug,
      note:
        "Keep the same target location, the same business identity, the same " +
        "selected topic angles, and the same slug. The slug is part of a URL " +
        "that may already be recorded, so return it unchanged even if you " +
        "change the title.",
    },
    approvedSources: serialiseSources(context.approvedSources),
    recentArticleTitles: context.recentArticleTitles,
    rules: [
      "Do not invent facts, sources, figures, reviews or credentials.",
      "A claim you cannot trace to an approved source must be removed from the article, not softened.",
      "Do not claim a check passes. The checks are re-run by a separate evaluator.",
      "Keep everything the previous draft got right; change what the failed checks name.",
      "Keep the same selected location and shared topic angles throughout revisions.",
      "Use the selected location angle as the main subject and the shared angle only where relevant.",
    ],
  });
}

// --- Provider adapter ------------------------------------------------------

let schemaModeSupported = true;

function rejectsResponseFormat(body: string) {
  return /response_format|json[_ ]schema|structured[_ ]outputs?/i.test(body);
}

export function resetSchemaModeForTests() {
  schemaModeSupported = true;
}

export async function requestArticle(
  userPrompt: string,
  model: string,
  key: string,
): Promise<ProviderResult> {
  let response: Response;
  const useSchema = schemaModeSupported;

  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
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
        response_format: useSchema
          ? { type: "json_schema", json_schema: ARTICLE_JSON_SCHEMA }
          : { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt() },
          { role: "user", content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "transient", code: "provider_timeout" };
  }

  if (!response.ok) {
    if (response.status === 429) {
      return {
        ok: false,
        kind: "transient",
        code: "provider_rate_limit",
        message: "provider responded 429",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }

    const permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 409;

    if (permanent && useSchema) {
      const body = await response.text().catch(() => "");

      if (rejectsResponseFormat(body)) {
        schemaModeSupported = false;

        console.warn(
          `provider rejected json_schema response format (HTTP ${response.status}); ` +
            "falling back to json_object for the rest of this process",
        );

        return requestArticle(userPrompt, model, key);
      }
    }

    return {
      ok: false,
      kind: permanent ? "permanent" : "transient",
      code: permanent ? "provider_request_rejected" : "provider_error",
      message: `provider responded ${response.status}`,
    };
  }

  const payload = await response.json().catch(() => null);
  const choice = payload?.choices?.[0];
  const raw = choice?.message?.content;
  const finishReason: string | undefined = choice?.finish_reason;
  const usage = payload?.usage;

  const reasoningTokens =
    usage?.completion_tokens_details?.reasoning_tokens ?? "unknown";
  const contentLength = typeof raw === "string" ? raw.length : 0;

  const truncated = (): ProviderResult => {
    console.error(
      `provider_output_truncated: finish_reason=length, completion_tokens=${
        usage?.completion_tokens ?? "unknown"
      }, reasoning_tokens=${reasoningTokens}, content_length=${contentLength}, ` +
        `max_tokens=${AI_MAX_TOKENS}`,
    );

    return {
      ok: false,
      kind: "transient",
      code: "provider_output_truncated",
      message:
        `finish_reason=length reasoning_tokens=${reasoningTokens} ` +
        `content_length=${contentLength} max_tokens=${AI_MAX_TOKENS}`,
    };
  };

  if (
    finishReason === "length" &&
    (typeof raw !== "string" || raw.trim() === "")
  ) {
    return truncated();
  }

  try {
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(
        `provider returned no article content (finish_reason=${finishReason ?? "unknown"})`,
      );
    }

    return {
      ok: true,
      article: ArticleSchema.parse(normaliseArticlePayload(JSON.parse(raw))),
    };
  } catch (error) {
    if (finishReason === "length") {
      return truncated();
    }

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
      }, content_length=${contentLength}):`,
      details ?? error,
    );

    return {
      ok: false,
      kind: "transient",
      code: "invalid_article_structure",
      message: JSON.stringify(details ?? String(error)).slice(0, 400),
    };
  }
}

// --- Main entry point ------------------------------------------------------

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

  const abandonJob = async (code: string, message?: string) => {
    const { error } = await supabase.rpc("abandon_generation_job", {
      p_job_id: jobId,
      p_code: code,
      p_message: message ?? code,
    });

    if (error) {
      console.error("could not record job abandonment:", error.message);
    }
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
      body: {
        error: "Location not found or disabled",
        code: "unknown_location",
      },
    };
  }

  // TOPIC ANGLES: fail safely if this enabled location has no angle config.
  // This check happens before claiming the job so a configuration error
  // does not consume a generation attempt.
  const locationTopicConfig = LOCATION_TOPICS.find(
    (item) => item.location === loc.slug,
  );

  // Lengths are read as plain numbers so a const-typed empty array still
  // trips this guard instead of being narrowed away at compile time.
  const locationAngleCount: number = Array.isArray(
    locationTopicConfig?.topicAngles,
  )
    ? locationTopicConfig.topicAngles.length
    : 0;
  const sharedAngleCount: number = SHARED_TOPIC_ANGLES.length;

  if (!locationTopicConfig || locationAngleCount === 0 || sharedAngleCount === 0) {
    console.error(`Missing topic configuration for location: ${loc.slug}`);

    return {
      httpStatus: 500,
      body: {
        error: "Location topic angles are not configured",
        code: "topic_config_missing",
      },
    };
  }

  // --- Topic angles are available -----------------------------------------

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

  // --- One article per job, enforced by a unique index --------------------

  const { data: existingPost, error: existingError } = await supabase
    .from("posts")
    .select(RESUME_SELECT)
    .eq("job_id", jobId)
    .maybeSingle();

  if (existingError) {
    console.error("existing article lookup failed:", existingError.message);

    return {
      httpStatus: 500,
      body: {
        error: "Could not check for an existing article",
        code: "server_error",
      },
    };
  }

  if (existingPost && existingPost.status === "published") {
    await supabase.rpc("complete_generation_job", {
      p_job_id: jobId,
      p_note: "recovered_existing_article",
    });

    return {
      httpStatus: 200,
      body: { post: existingPost, alreadyGenerated: true },
    };
  }

  if (existingPost && existingPost.status !== "needs_review") {
    await abandonJob(
      "article_not_resumable",
      `the article for this job is in status '${existingPost.status}', which only a person sets; it is not revised automatically`,
    );

    return {
      httpStatus: 200,
      body: {
        post: existingPost,
        needsManualReview: true,
        code: "article_not_resumable",
        status: existingPost.status,
      },
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

  if (existingPost) {
    const ageMs =
      Date.now() - new Date(existingPost.created_at as string).getTime();
    const maxAgeMs = MAX_ARTICLE_REVISION_AGE_HOURS * 3_600_000;

    if (ageMs > maxAgeMs) {
      await abandonJob(
        "revision_window_expired",
        `draft has been in revision for ${Math.round(ageMs / 3_600_000)}h, which exceeds MAX_ARTICLE_REVISION_AGE_HOURS=${MAX_ARTICLE_REVISION_AGE_HOURS}`,
      );

      return {
        httpStatus: 200,
        body: {
          post: existingPost,
          needsManualReview: true,
          code: "revision_window_expired",
          revisions: existingPost.revision_count,
        },
      };
    }
  }

  // --- Context: approved sources and existing content ---------------------

  const [sourcesResult, titlesResult, contentsResult] = await Promise.all([
    supabase
      .from("content_sources")
      .select("source_name,source_url,notes")
      .eq("approved", true),
    supabase.from("posts").select("id,title,slug"),
    supabase
      .from("posts")
      .select("id,slug,content,location_id")
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

  const ownPostId = (existingPost?.id as string | undefined) ?? null;

  const existingTitles = (titlesResult.data ?? [])
    .filter((row) => row.id !== ownPostId)
    .map((row) => row.title as string);

  const existingSlugs = (titlesResult.data ?? [])
    .filter((row) => row.id !== ownPostId)
    .map((row) => row.slug as string);

  const existingContents = (contentsResult.data ?? [])
    .filter((row) => row.id !== ownPostId)
    .map((row) => ({
      slug: row.slug as string,
      content: (row.content as string | null) ?? "",
    }));

  // --- Provider -----------------------------------------------------------

  const model = process.env.OPENROUTER_MODEL;
  const key = process.env.OPENROUTER_API_KEY;

  if (!model || !key) {
    await failJob("ai_provider_not_configured");

    return {
      httpStatus: 503,
      body: {
        error: "AI provider not configured",
        code: "provider_not_configured",
      },
    };
  }

  // TOPIC ANGLES: choose the angles once per job. All revisions receive the
  // same PromptContext, preventing the article from drifting to a new subject.
  const topicAngle = stablePick(
    locationTopicConfig.topicAngles,
    `${jobId}:${loc.slug}:location-angle`,
  );

  const sharedAngle = stablePick(
    SHARED_TOPIC_ANGLES,
    `${jobId}:${loc.slug}:shared-angle`,
  );

  const promptContext: PromptContext = {
    locationName: loc.name as string,
    topic: input.topic,
    topicAngle,
    sharedAngle,
    recentArticleTitles: existingTitles.slice(0, 40),
    approvedSources,
  };

  console.log(
    `[topics] job=${jobId} location=${loc.slug} ` +
      `topicAngle="${topicAngle}" sharedAngle="${sharedAngle}"`,
  );

  // --- The evaluator ------------------------------------------------------

  const imageByDraft = new Map<Article, FeaturedImage | null>();
  let matchedImage: FeaturedImage | null = null;

  const evaluate = async (article: Article): Promise<DraftEvaluation> => {
    const quality = checkQuality(article, {
      locationName: loc.name as string,
      existingTitles,
      existingSlugs,
      existingContents,
      approvedSources,
    });

    const declaredSourceUrls = [
      ...article.sources,
      ...article.claims
        .map((claim) => claim.sourceUrl)
        .filter((url): url is string => typeof url === "string"),
    ];

    const [verification, image] = await Promise.all([
      verifySources(declaredSourceUrls, approvedSources),
      matchedImage
        ? Promise.resolve(matchedImage)
        : findWikimediaImage(loc.name as string, article.title).catch(
            (error) => {
              console.error("image lookup failed:", error);
              return null;
            },
          ),
    ]);

    if (image) {
      matchedImage = image;
    }

    imageByDraft.set(article, image);

    const blocking = [...quality.reasons];

    if (!image) {
      blocking.push("image_not_verified");
    }

    if (verification.status !== "verified") {
      console.warn(
        `Source verification failed for article: ${article.title}, status: ${verification.status}`,
      );
      blocking.push(`verification_${verification.status}`);
    }

    const uniqueBlocking = [...new Set(blocking)];

    return {
      score: quality.score,
      pass:
        uniqueBlocking.length === 0 &&
        quality.score >= MIN_ARTICLE_QUALITY_SCORE,
      blocking: uniqueBlocking,
      quality,
      verification,
      imageOk: Boolean(image),
    };
  };

  // --- Resume an earlier cycle's draft, or start a new one ----------------

  let resumeFrom: { article: Article } | null = null;

  if (existingPost?.best_draft) {
    const parsed = ArticleSchema.safeParse(existingPost.best_draft);

    if (parsed.success) {
      resumeFrom = { article: parsed.data };
    } else {
      console.warn(
        `stored best_draft for job ${jobId} no longer matches the article schema; starting a fresh draft for the same job`,
      );
    }
  }

  const carriedRevisions =
    (existingPost?.revision_count as number | undefined) ?? 0;

  const carriedProviderRetries =
    (existingPost?.provider_retry_count as number | undefined) ?? 0;

  const draftState = existingPost?.best_draft
    ? resumeFrom
      ? "resumed"
      : "stored_draft_invalid"
    : "no_stored_draft";

  console.log(
    `[cycle] job=${jobId} location=${loc.slug as string} model=${model} ` +
      `draft=${draftState} carriedRevisions=${carriedRevisions} ` +
      `carriedProviderRetries=${carriedProviderRetries} budgetMs=${
        input.budgetMs ?? QUALITY_CYCLE_BUDGET_MS
      } schemaMode=${schemaModeSupported ? "json_schema" : "json_object"}`,
  );

  // --- Generate, evaluate, improve, re-evaluate ---------------------------

  const attemptLog: AttemptLog[] = [];

  const loop: LoopResult = await runImprovementLoop(
    {
      generateInitial: () =>
        requestArticle(buildUserPrompt(promptContext), model, key),

      reviseDraft: (request) =>
        requestArticle(
          buildRevisionPrompt(request, {
            ...promptContext,
            preserveSlug: request.draft.slug,
          }),
          model,
          key,
        ),

      evaluate,

      heartbeat: async () => {
        const { error } = await supabase
          .from("generation_jobs")
          .update({ processing_started_at: new Date().toISOString() })
          .eq("id", jobId)
          .eq("status", "processing");

        if (error) {
          console.error("lease heartbeat failed:", error.message);
        }
      },

      log: (entry) => {
        attemptLog.push(entry);

        console.log(
          `[revision] job=${jobId} attempt=${entry.attempt} kind=${entry.kind} ` +
            `score=${entry.score ?? "n/a"} pass=${entry.pass} ` +
            `blocking=${entry.blocking.join("|") || "none"} ` +
            `verification=${entry.verificationStatus ?? "n/a"} ` +
            `provider=${entry.providerCode ?? "ok"} ` +
            `providerRetries=${entry.providerRetries} elapsedMs=${entry.elapsedMs}`,
        );
      },
    },
    {
      budgetMs: input.budgetMs,
      minCallBudgetMs: AI_REQUEST_TIMEOUT_MS,
      resumeFrom,
    },
  );

  const totalRevisions = carriedRevisions + loop.revisions;
  const totalProviderRetries = carriedProviderRetries + loop.providerRetries;

  // --- Nothing to save ----------------------------------------------------

  if (!loop.best) {
    const code = loop.lastError?.code ?? "generation_failed";

    if (loop.outcome === "terminal") {
      await abandonJob(code, loop.lastError?.message);

      return {
        httpStatus: 500,
        body: {
          error:
            "The provider rejected the request in a way retrying cannot fix. The job needs an operator.",
          code,
          retryable: false,
          attempts: attemptLog,
        },
      };
    }

    await failJob(code, loop.lastError?.message);

    return {
      httpStatus: 503,
      body: {
        error: "No draft could be produced; the job is retained for retry",
        code,
        retryable: true,
        providerRetries: totalProviderRetries,
        attempts: attemptLog,
      },
    };
  }

  // --- Persist ------------------------------------------------------------

  const { article, evaluation } = loop.best;
  const passed = loop.outcome === "passed" && evaluation.pass;

  const autoPublishAllowed = process.env.AUTO_PUBLISH_ENABLED === "true";
  const publish = passed && autoPublishAllowed;

  if (passed && !autoPublishAllowed) {
    evaluation.quality.warnings.push("auto_publish_disabled");
  }

  const licensedImage = imageByDraft.get(article) ?? null;
  const base = siteUrl();
  const now = new Date().toISOString();

  const declaredSourceUrls = [
    ...article.sources,
    ...article.claims
      .map((claim) => claim.sourceUrl)
      .filter((url): url is string => typeof url === "string"),
  ];

  const latestDraft =
    loop.latest && loop.latest.article !== article
      ? {
          article: loop.latest.article,
          score: loop.latest.evaluation.score,
          blocking: loop.latest.evaluation.blocking,
        }
      : null;

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

    quality_score:
      evaluation.blocking.length === 0
        ? evaluation.score
        : Math.min(evaluation.score, 60),
    quality_reasons: evaluation.blocking,
    verification_status: evaluation.verification.status,
    verified_claims: evaluation.quality.details.verifiedClaims,
    source_urls: [...new Set(declaredSourceUrls)],

    revision_count: totalRevisions,
    provider_retry_count: totalProviderRetries,
    best_quality_score: evaluation.score,
    best_draft: article,
    latest_draft: latestDraft,
    last_revision_at: now,

    review_notes: passed
      ? null
      : [
          `Blocked by: ${evaluation.blocking.join(", ") || `score ${evaluation.score} < ${MIN_ARTICLE_QUALITY_SCORE}`}`,
          `Revisions attempted: ${totalRevisions}, provider retries: ${totalProviderRetries}, outcome: ${loop.outcome}`,
          ...buildCorrectionInstructions(evaluation),
          evaluation.quality.details.undeclaredMaterialSentences.length > 0
            ? `Undeclared material sentences: ${JSON.stringify(
                evaluation.quality.details.undeclaredMaterialSentences,
              )}`
            : null,
          evaluation.quality.details.unverifiedClaims.length > 0
            ? `Unverified claims: ${JSON.stringify(evaluation.quality.details.unverifiedClaims)}`
            : null,
          evaluation.quality.details.unrecognisedPlaces.length > 0
            ? `Unrecognised places: ${evaluation.quality.details.unrecognisedPlaces.join(", ")}`
            : null,
          loop.lastError ? `Last provider error: ${loop.lastError.code}` : null,
        ]
          .filter(Boolean)
          .join("\n"),

    image_url: licensedImage?.image_url ?? null,
    image_alt: licensedImage?.image_alt ?? null,
    image_credit: licensedImage?.image_credit ?? null,
    image_source_url: licensedImage?.image_source_url ?? null,
    image_provider: licensedImage?.image_provider ?? null,
    image_mime: licensedImage?.image_mime ?? null,
    image_width: licensedImage?.image_width ?? null,
    image_height: licensedImage?.image_height ?? null,
    image_license: licensedImage?.image_license ?? null,
    image_license_url: licensedImage?.image_license_url ?? null,
  };

  const { data: post, error: saveError } = existingPost
    ? await supabase
        .from("posts")
        .update(postData)
        .eq("id", existingPost.id as string)
        .select(POST_RETURN_COLUMNS)
        .single()
    : await supabase
        .from("posts")
        .insert(postData)
        .select(POST_RETURN_COLUMNS)
        .single();

  if (saveError || !post) {
    console.error("article save failed:", saveError?.message);

    const { data: recovered } = await supabase
      .from("posts")
      .select(POST_RETURN_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle();

    if (
      recovered &&
      (recovered as { status?: string }).status === "published"
    ) {
      await supabase.rpc("complete_generation_job", {
        p_job_id: jobId,
        p_note: "recovered_existing_article",
      });

      return {
        httpStatus: 200,
        body: { post: recovered, alreadyGenerated: true },
      };
    }

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

  // --- Job state ----------------------------------------------------------

  let jobState: Record<string, unknown> | null = null;

  if (passed) {
    await supabase.rpc("complete_generation_job", {
      p_job_id: jobId,
      p_note: `passed after ${totalRevisions} revision(s)`,
    });
  } else if (loop.outcome === "terminal") {
    await abandonJob(
      loop.lastError?.code ?? "revision_unrecoverable",
      loop.lastError?.message,
    );
  } else {
    jobState = await failJob(
      "quality_below_threshold",
      `score=${evaluation.score} blocking=${evaluation.blocking.join(",") || "none"} revisions=${totalRevisions}`,
    );
  }

  let delivery: { ok: boolean; deliveryId?: string; error?: string } | null =
    null;

  if (publish) {
    try {
      const { revalidateTag } = await import("next/cache");
      revalidateTag(POSTS_CACHE_TAG);
    } catch {
      // Expected when running outside a Next.js request context.
    }

    delivery = await enqueueDelivery(supabase, post.id as string, "published");
  }

  const { error: activityError } = await supabase.from("activity_log").insert({
    action: publish
      ? "auto_published"
      : passed
        ? "passed_pending_publish"
        : "generated_for_review",
    entity_type: "post",
    entity_id: post.id,
    details: {
      model,
      job_id: jobId,
      location: loc.slug,
      topic_angle: topicAngle,
      shared_angle: sharedAngle,
      quality_score: postData.quality_score,
      quality_reasons: evaluation.blocking,
      quality_warnings: evaluation.quality.warnings,
      words: evaluation.quality.details.words,
      max_content_similarity: evaluation.quality.details.maxContentSimilarity,
      verification_status: evaluation.verification.status,
      verification_checks: evaluation.verification.checks,
      verified_claim_count: evaluation.quality.details.verifiedClaims.length,
      unverified_claims: evaluation.quality.details.unverifiedClaims,
      unrecognised_places: evaluation.quality.details.unrecognisedPlaces,
      undeclared_material_sentences:
        evaluation.quality.details.undeclaredMaterialSentences,
      image_found: Boolean(licensedImage),
      image_provider: licensedImage?.image_provider ?? null,
      image_license: licensedImage?.image_license ?? null,
      delivery_enqueued: delivery?.ok ?? null,
      delivery_id: delivery?.deliveryId ?? null,
      loop_outcome: loop.outcome,
      revisions: totalRevisions,
      provider_retries: totalProviderRetries,
      revision_attempts: attemptLog,
    },
  });

  if (activityError) {
    console.error("activity logging failed:", activityError.message);
  }

  return {
    httpStatus: passed ? (existingPost ? 200 : 201) : 202,
    body: {
      post,
      published: publish,
      delivery,
      loop: {
        outcome: loop.outcome,
        revisions: totalRevisions,
        providerRetries: totalProviderRetries,
        attempts: attemptLog,
        nextAttemptAt: jobState?.nextAttemptAt ?? null,
        exhausted: jobState?.exhausted ?? (loop.outcome === "terminal" || null),
      },
      retryable: !passed && loop.outcome === "retry_later",
      quality: {
        score: postData.quality_score,
        pass: passed,
        reasons: evaluation.blocking,
        warnings: evaluation.quality.warnings,
        words: evaluation.quality.details.words,
        maxContentSimilarity: evaluation.quality.details.maxContentSimilarity,
        unverifiedClaims: evaluation.quality.details.unverifiedClaims,
        unrecognisedPlaces: evaluation.quality.details.unrecognisedPlaces,
        undeclaredMaterialSentences:
          evaluation.quality.details.undeclaredMaterialSentences,
      },
      verification: evaluation.verification,
      image: licensedImage
        ? {
            provider: licensedImage.image_provider,
            sourceUrl: licensedImage.image_source_url,
            license: licensedImage.image_license,
            licenseUrl: licensedImage.image_license_url,
          }
        : null,
    },
  };
}
