// Shared configuration. Deliberately free of any Next.js import, so the
// scheduled worker in scripts/ can use it outside a Next runtime.

// The platform's own timezone. Everything that means "a day" — the single daily
// generation slot, rotation fairness, article date display — resolves through
// this, never through the server's local time or UTC.
export const PLATFORM_TIMEZONE = "Europe/London";

export const PLATFORM_LOCALE = "en-GB";

export const POSTS_CACHE_TAG = "posts";
export const LOCATIONS_CACHE_TAG = "locations";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

export function siteUrl() {
  return (process.env.SITE_URL || "https://content.westerncars.com").replace(
    /\/$/,
    "",
  );
}

// --- Provider and quality improvement loop ------------------------------
//
// Validated at module load: a misconfigured threshold would otherwise either
// publish unchecked articles or spend the provider budget on a target nothing
// can reach. A bad value is a configuration error, not something to paper over
// with a default, so it throws.

function intEnv(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max}; received ${JSON.stringify(raw)}`,
    );
  }

  return value;
}

/**
 * How long to wait for a single article-generation request.
 *
 * Measured against the configured reasoning model: a full article costs roughly
 * 6000 reasoning tokens plus 1300 content tokens and takes 60-115 seconds. That
 * does not fit Vercel's Hobby 60-second function limit, which is why the daily
 * run is a GitHub Actions worker and the in-request endpoints are a fallback
 * for short jobs only. The worker raises this via the environment; the default
 * stays inside what a short in-request job can survive.
 *
 * Validated rather than coerced: `Number(undefined-ish)` yields NaN, and a NaN
 * timeout makes `AbortSignal.timeout` throw on every provider call while a NaN
 * `minCallBudgetMs` makes every budget comparison false, so the loop would
 * start calls it has no time to finish.
 */
export const AI_REQUEST_TIMEOUT_MS = intEnv(
  "AI_REQUEST_TIMEOUT_MS",
  45_000,
  5_000,
  900_000,
);

/**
 * Completion-token ceiling for one provider call.
 *
 * The configured model is a reasoning model, so this budget has to cover
 * thinking *and* a 650-1000 word article. Reasoning spend is variable, not
 * fixed: at 10_000 runs have burned the entire budget on reasoning (empty
 * content, finish_reason 'length') or stopped mid-JSON partway through the
 * article, failing the job outright. It is a ceiling rather than a spend —
 * unused tokens are not billed — so it sits well above the worst observed
 * reasoning burn plus a full article.
 */
export const AI_MAX_TOKENS = intEnv("AI_MAX_TOKENS", 32_000, 2_000, 200_000);

/**
 * The score an article must reach to be eligible for publication.
 *
 * The database trigger `posts_enforce_publication_eligibility` enforces its own
 * floor of 85. Setting this below 85 therefore does not loosen anything: the
 * insert would be rejected. Setting it above 85 makes the application stricter
 * than the database, which is the only direction that works.
 */
export const MIN_ARTICLE_QUALITY_SCORE = intEnv(
  "MIN_ARTICLE_QUALITY_SCORE",
  50,
  0,
  100,
);

/** Content revisions attempted in one processing cycle. */
export const MAX_QUALITY_REVISIONS = intEnv("MAX_QUALITY_REVISIONS", 2, 0, 20);

/**
 * Retries for *provider* failures (rate limits, timeouts, malformed output).
 * Counted separately from content revisions: a 429 is not a bad article.
 */
export const MAX_PROVIDER_RETRIES = intEnv("MAX_PROVIDER_RETRIES", 3, 0, 10);

/**
 * How long one processing cycle may spend before it stops revising, saves the
 * best draft and leaves the job for the next cycle. The default suits the
 * GitHub Actions worker; the Vercel routes are bounded far lower by their own
 * 60-second ceiling and pass an explicit budget.
 */
export const QUALITY_CYCLE_BUDGET_MS = intEnv(
  "QUALITY_CYCLE_BUDGET_MS",
  15 * 60_000,
  30_000,
  60 * 60_000,
);

/**
 * After this long, a draft that still has not passed stops being retried and
 * is left for manual review. Without it a permanently failing article would
 * hold its location's rotation turn indefinitely.
 */
export const MAX_ARTICLE_REVISION_AGE_HOURS = intEnv(
  "MAX_ARTICLE_REVISION_AGE_HOURS",
  72,
  1,
  720,
);
