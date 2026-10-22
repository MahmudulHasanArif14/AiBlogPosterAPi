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

// The whole generation pipeline, callable from both the manual endpoint and the
// scheduled cron. It is deliberately a plain function rather than an internal
// HTTP call: this project runs on Vercel's Hobby plan, where a function is
// killed at 60 seconds, so a cron that waited on a second function's full
// request budget could never finish.
//
// A draft that fails the quality gate is not abandoned. It goes back to the
// provider with the exact checks it failed and is re-evaluated by the same
// evaluator, repeatedly, until it passes or a bound is reached. The bounds and
// the resume semantics live in ./revision; this module supplies the provider,
// the evaluator and the persistence.

// The token budget lives in ./config with the other validated env knobs.
// Measured against the configured reasoning model: ~6000 reasoning + ~1300
// content tokens, 60-115 seconds end to end. `reasoning: { effort: "low" }`
// made it *slower* (113s vs 58s unset), and `reasoning: { exclude: true }` only
// hides reasoning from the response without saving the tokens. Neither is used.

export type GenerationOutcome = {
  httpStatus: number;
  body: Record<string, unknown>;
};

export type GenerationInput = {
  jobId: string;
  locationSlug: string;
  topic: string;
  /**
   * How long this cycle may spend revising. The scheduled worker leaves it
   * unset and uses the configured default; the Vercel routes pass something
   * well inside their own 60-second ceiling.
   */
  budgetMs?: number;
};

const POST_RETURN_COLUMNS =
  "id,title,slug,status,published_at,canonical_url,image_url,image_source_url,image_license";

/**
 * Everything a resumed cycle needs about the draft an earlier cycle left,
 * plus the columns the API returns. One select, no duplicated column names.
 */
const RESUME_SELECT =
  "id,title,slug,status,published_at,canonical_url,image_url,image_source_url,image_license,created_at,revision_count,provider_retry_count,best_quality_score,best_draft";

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

type PromptContext = {
  locationName: string;
  topic: string;
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

function buildUserPrompt(input: PromptContext) {
  return JSON.stringify({
    location: input.locationName,
    topicInstructions: input.topic,
    recentArticleTitles: input.recentArticleTitles,
    approvedSources: serialiseSources(input.approvedSources),
    requirements:
      "Choose the specific subject and angle yourself, using the location and " +
      "topic instructions as context rather than as a fixed title. Pick one " +
      "concrete reader question and answer it properly. Avoid repeating the " +
      "angle of any recent article title listed above. Return only the JSON " +
      "object described in the system message.",
  });
}

/**
 * The correction prompt. It carries the previous draft, the checks it actually
 * failed and the evidence behind them, so a revision can fix the named
 * weaknesses rather than re-rolling the article.
 *
 * It never asks the model to invent a fact, fabricate a source, adjust a score
 * or declare a failed check passed: an unsupportable claim has to leave the
 * article. The evaluator rescores the result; nothing the model says about its
 * own quality is read.
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
      slug: context.preserveSlug,
      note:
        "Keep the same target location, the same business identity, and the " +
        "same slug. The slug is part of a URL that may already be recorded, " +
        "so return it unchanged even if you change the title.",
    },
    approvedSources: serialiseSources(context.approvedSources),
    recentArticleTitles: context.recentArticleTitles,
    rules: [
      "Do not invent facts, sources, figures, reviews or credentials.",
      "A claim you cannot trace to an approved source must be removed from the article, not softened.",
      "Do not claim a check passes. The checks are re-run by a separate evaluator.",
      "Keep everything the previous draft got right; change what the failed checks name.",
    ],
  });
}

// --- Provider adapter ------------------------------------------------------

/**
 * Whether the provider has accepted schema-constrained output.
 *
 * OpenRouter advertises `structured_outputs` for the configured model, but the
 * backing provider for a given request is the one that has to honour it. A
 * rejection is therefore a capability discovery, not a job failure: the call is
 * retried immediately in plain JSON mode and the process stops asking. That
 * keeps the stronger constraint when it works without making the pipeline
 * depend on it.
 */
let schemaModeSupported = true;

/**
 * True when a 4xx body names the *response format* rather than the request.
 *
 * Deliberately narrow. An earlier version also matched a bare "schema", which
 * any number of unrelated validation errors mention -- that would have turned
 * a real rejection into a silent capability downgrade and hidden the actual
 * error behind a second request. Only wording that names the response format
 * itself counts.
 */
function rejectsResponseFormat(body: string) {
  return /response_format|json[_ ]schema|structured[_ ]outputs?/i.test(body);
}

export function resetSchemaModeForTests() {
  schemaModeSupported = true;
}

/**
 * One provider call, classified for the retry policy.
 *
 * `permanent` covers the errors retrying cannot fix — bad credentials, a
 * rejected request, a model that does not exist. Everything else (rate limits,
 * 5xx, timeouts, truncated or unparseable output) is transient and gets a
 * bounded, jittered retry.
 *
 * Exported so the adapter can be tested against a stubbed `fetch`.
 */
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

    // 408 and 409 are worth another go; the rest of the 4xx range is the
    // request itself being wrong, which a retry cannot change.
    const permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408 &&
      response.status !== 409;

    // One exception: a 4xx that names the response format is the provider
    // declining schema-constrained output, not declining the article. The
    // capability is switched off and the call is made again in plain JSON
    // mode, so a provider that cannot constrain output degrades to the old
    // behaviour instead of failing the job.
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

  // A response that ran out of completion budget is a budget problem, not a
  // bad article, and the two need different fixes. It is reported as truncated
  // whether the content came back empty (the whole budget went on reasoning)
  // or partial (cut off mid-JSON): previously only the empty case was
  // recognised, so a half-written article was misreported as
  // `invalid_article_structure` and sent back to the model as though its
  // writing were at fault.
  //
  // Hitting the ceiling exactly on the closing brace is possible, so a
  // complete, valid article is still accepted below before this is concluded.
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

  if (finishReason === "length" && (typeof raw !== "string" || raw.trim() === "")) {
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
    // Ran out of budget mid-article: a truncation, not a malformed article.
    // Never repaired by appending the missing brackets -- the article behind a
    // cut-off string is incomplete, and completing its syntax would only make
    // partial content look finished.
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

    // A malformed or schema-violating response is the model's output, not the
    // request: another attempt is worth making, bounded by the provider retry
    // budget rather than retried forever.
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

  // --- One article per job, enforced by a unique index --------------------
  //
  // An existing article is not automatically the end of the job. A published
  // one is: there is nothing left to do. A draft still in review is the work in
  // progress of an earlier cycle, and this cycle resumes *that* draft rather
  // than generating a new article — which is what stops a revision consuming
  // another day's rotation turn.

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

  // An operator's decision is final. `failed` is what /api/admin/review writes
  // when someone rejects a draft, and `draft`/`queued` are states this pipeline
  // never produces, so in both cases a human owns the row. Revising it would
  // overwrite their decision and flip the article back into the review queue.
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
    // Another worker holds the lease, the retry window has not opened, or the
    // attempts are spent. Either way this process must not revise the article:
    // two concurrent revisions of one draft would overwrite each other.
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

  // A draft that has been in revision for too long stops being retried: the
  // loop cannot promise that a permanently failing article will ever pass, and
  // an unbounded retry would hold this location's rotation turn indefinitely.
  //
  // This is checked only once the claim is held. Abandoning a job on the
  // strength of a read alone could terminate one another worker is part-way
  // through revising.
  if (existingPost) {
    const ageMs = Date.now() - new Date(existingPost.created_at as string).getTime();
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

  // The article being revised must not count as its own duplicate, so the row
  // this job owns is excluded from the duplication corpus.
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
    // Bounded by the job's own attempt budget rather than abandoned outright:
    // the fix is an environment variable, and once it is set the next cycle
    // should pick the job up instead of needing a manual requeue.
    await failJob("ai_provider_not_configured");

    return {
      httpStatus: 503,
      body: { error: "AI provider not configured", code: "provider_not_configured" },
    };
  }

  const promptContext: PromptContext = {
    locationName: loc.name as string,
    topic: input.topic,
    recentArticleTitles: existingTitles.slice(0, 40),
    approvedSources,
  };

  // --- The evaluator ------------------------------------------------------
  //
  // The single source of truth for pass and fail, used identically on the first
  // draft and on every revision. The score it returns is the one that is
  // stored; the model's opinion of its own article is never read.
  //
  // The provenance check and the image lookup are network-bound and independent
  // of each other, so they run together: sequentially they were the two slowest
  // steps after generation.

  // The image each draft was evaluated with, so the row that is saved carries
  // the licence that was actually checked against the draft being saved --
  // not whatever the last revision happened to find.
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
      // A licence once matched stays matched: re-fetching it on every revision
      // would spend the cycle's budget re-answering a settled question.
      matchedImage
        ? Promise.resolve(matchedImage)
        : findWikimediaImage(loc.name as string, article.title).catch((error) => {
            console.error("image lookup failed:", error);
            return null;
          }),
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
      blocking.push(`verification_${verification.status}`);
    }

    const uniqueBlocking = [...new Set(blocking)];

    return {
      score: quality.score,
      // Both conditions, always: the score *and* every mandatory gate. A high
      // score can never carry a failed provenance check.
      pass: uniqueBlocking.length === 0 && quality.score >= MIN_ARTICLE_QUALITY_SCORE,
      blocking: uniqueBlocking,
      quality,
      verification,
      imageOk: Boolean(image),
    };
  };

  // --- Resume an earlier cycle's draft, or start a new one -----------------

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

  const carriedRevisions = (existingPost?.revision_count as number | undefined) ?? 0;
  const carriedProviderRetries =
    (existingPost?.provider_retry_count as number | undefined) ?? 0;

  // The scheduler's own label says whether the *job* was resumed, which is not
  // the same as whether a *draft* was. A resumed job with no stored draft
  // legitimately generates a first article, and without this line the run
  // reads as `mode=resume_revision` with every attempt `kind=initial` and
  // looks like a control-flow bug.
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
      // A full cycle can outlast the five-minute processing lease, which would
      // let a second worker take the job mid-revision.
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
      // A call that cannot finish inside what is left of the cycle is not
      // started: the next cycle resumes the draft instead.
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

  // The latest revision is only worth keeping separately when it was not the
  // draft we are storing: that is the diagnosis case.
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

    // Reaching the retry limit is never a reason to publish. Only the
    // evaluator's verdict can move an article out of review.
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

    // A previous attempt may have saved the article before failing to report.
    const { data: recovered } = await supabase
      .from("posts")
      .select(POST_RETURN_COLUMNS)
      .eq("job_id", jobId)
      .maybeSingle();

    if (recovered && (recovered as { status?: string }).status === "published") {
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

  // --- Job state ----------------------------------------------------------
  //
  // Only a passing article completes the job. A draft that is still below the
  // bar goes back to the retry queue with the job's own backoff, so the next
  // cycle resumes it; once the job's attempt budget is spent fail_generation_job
  // makes it 'exhausted' and the draft stays in review for a person to pick up.

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

  // Clear the cached listings so a newly published article is visible on the
  // next request rather than after the revalidate window. Outside a Next
  // request context -- the scheduled worker -- this is a no-op, and the worker
  // calls /api/admin/revalidate instead.
  let delivery: { ok: boolean; deliveryId?: string; error?: string } | null =
    null;

  if (publish) {
    try {
      const { revalidateTag } = await import("next/cache");
      revalidateTag(POSTS_CACHE_TAG);
    } catch {
      // Not running inside Next. Expected for the scheduled worker.
    }

    // Record that the location's website is owed a notification. This writes a
    // queue row and nothing more: no HTTP request is made on the generation
    // path, because generation already takes 60-115 seconds and must not also
    // wait on someone else's website.
    //
    // enqueueDelivery never throws. If this fails, the article is still
    // published and the scheduled reconciler picks it up within one interval.
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
    // A draft that will be revised again is not an error and not a success:
    // 202 says the work is accepted and still in progress.
    httpStatus: passed ? (existingPost ? 200 : 201) : 202,
    body: {
      post,
      published: publish,
      // Surfaced so the worker's log says whether distribution was queued, not
      // just whether the article published.
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
