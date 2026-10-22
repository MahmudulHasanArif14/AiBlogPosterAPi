import type { Article } from "./article";
import {
  MAX_PROVIDER_RETRIES,
  MAX_QUALITY_REVISIONS,
  MIN_ARTICLE_QUALITY_SCORE,
  QUALITY_CYCLE_BUDGET_MS,
} from "./config";
import type { QualityResult } from "./quality";
import type { VerificationResult } from "./verification";

// The automatic improvement loop.
//
// A draft that fails the gate is not thrown away and re-rolled. It is sent back
// to the provider together with the exact checks it failed, and the revision is
// put through the *same* evaluator again. Nothing here decides whether an
// article is good: `evaluate` does, and this module only reacts to its verdict.
//
// Two budgets are tracked separately on purpose. A content revision means the
// article was wrong; a provider retry means the call was. Conflating them let a
// single rate limit burn the revision budget.
//
// The loop is bounded three ways — revisions, provider retries, wall-clock
// budget — and every exit either passes, asks for another cycle later, or is
// terminal. It never promises that a failing article will eventually pass.

export type DraftEvaluation = {
  /** The evaluator's score. Never self-reported by the model. */
  score: number;
  /** True only when the score is met *and* no mandatory gate failed. */
  pass: boolean;
  /** Every failed check, including the non-text gates. */
  blocking: string[];
  quality: QualityResult;
  verification: VerificationResult;
  imageOk: boolean;
};

export type ProviderResult =
  | { ok: true; article: Article }
  | {
      ok: false;
      /**
       * `transient` is worth another provider attempt (rate limit, timeout,
       * malformed output). `permanent` is not (bad credentials, missing
       * configuration): retrying it only wastes the budget.
       */
      kind: "transient" | "permanent";
      code: string;
      message?: string;
      /** From a `Retry-After` header, when the provider sent one. */
      retryAfterMs?: number;
    };

export type RevisionRequest = {
  draft: Article;
  /** The failed check identifiers, straight from the evaluator. */
  failures: string[];
  /** The corrective instructions those failures translate into. */
  instructions: string[];
  evaluation: DraftEvaluation;
};

export type LoopDeps = {
  /** Ask the provider for a first draft. */
  generateInitial: () => Promise<ProviderResult>;
  /** Ask the provider to improve a specific draft. */
  reviseDraft: (request: RevisionRequest) => Promise<ProviderResult>;
  /** The real evaluator: quality gate, provenance check, image check. */
  evaluate: (article: Article) => Promise<DraftEvaluation>;
  /** Extend the job's processing lease so a long cycle is not stolen. */
  heartbeat?: () => Promise<void>;
  /** Structured attempt log. */
  log?: (entry: AttemptLog) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type AttemptLog = {
  attempt: number;
  kind: "initial" | "revision";
  score: number | null;
  pass: boolean;
  blocking: string[];
  verificationStatus: string | null;
  providerCode: string | null;
  providerRetries: number;
  elapsedMs: number;
};

export type LoopOptions = {
  maxRevisions?: number;
  maxProviderRetries?: number;
  budgetMs?: number;
  /** The score the evaluator must reach. Used only to phrase instructions. */
  minScore?: number;
  /**
   * How much of the cycle budget a provider call needs before it is worth
   * starting -- in practice the provider timeout. Without it the loop can
   * start a call it has no time to finish and overrun its budget by a whole
   * timeout, which on a platform with a hard function ceiling means being
   * killed mid-flight with the job still marked `processing`.
   *
   * The first call of a cycle is always attempted, so a tight budget still
   * produces a draft rather than nothing at all.
   */
  minCallBudgetMs?: number;
  /**
   * A draft carried over from an earlier cycle. When present the loop improves
   * it instead of generating a new article, which is what keeps a resumed job
   * from consuming another rotation turn.
   */
  resumeFrom?: { article: Article; evaluation?: DraftEvaluation } | null;
};

export type LoopOutcome =
  /** Passed every mandatory gate and met the score. Eligible for publication. */
  | "passed"
  /** Did not pass, but is worth another cycle later. The draft is preserved. */
  | "retry_later"
  /** Cannot recover without an operator. No further cycles. */
  | "terminal"
  /** Nothing was produced at all, so there is no draft to preserve. */
  | "no_draft";

export type LoopResult = {
  outcome: LoopOutcome;
  /** The best draft seen, which is what may be published or reviewed. */
  best: { article: Article; evaluation: DraftEvaluation } | null;
  /** The most recent draft, kept for diagnosis when it was not the best. */
  latest: { article: Article; evaluation: DraftEvaluation } | null;
  revisions: number;
  providerRetries: number;
  lastError: { code: string; message?: string } | null;
  attempts: AttemptLog[];
};

// --- Correction instructions -----------------------------------------------
//
// Each failed check becomes one concrete thing to fix. None of them tells the
// model to invent anything, to fabricate a source, or to treat a check as
// passed: a claim it cannot support has to come out of the article.

const CHECK_INSTRUCTIONS: Record<string, string> = {
  content_too_short:
    "The article is too thin. Add genuinely useful depth for this location — concrete choices, trade-offs and what to check before travelling. Do not pad with restatement or filler.",
  missing_paragraph_structure:
    "Restructure the body into at least four substantial paragraphs separated by a single blank line, each covering a distinct part of the reader's problem.",
  html_in_content:
    "Remove every HTML tag from content. It must be plain text with no markup.",
  meta_description_length:
    "Rewrite metaDescription so it is between 100 and 160 characters, reads as a real summary, and matches the article's search intent.",
  excerpt_duplicates_title:
    "Rewrite excerpt so it adds information instead of restating the title: say what the reader will be able to decide after reading.",
  duplicate_title:
    "The title collides with an existing article. Choose a different, more specific angle and title — do not merely reword it.",
  duplicate_slug:
    "The slug collides with an existing article. Derive a new slug from the new title.",
  duplicate_content:
    "The body closely duplicates an existing article for this location. Rewrite it around a different reader question, with different structure and substance.",
  placeholder_text:
    "Remove all placeholder, template and assistant-preamble text. Return only the finished article.",
  unsupported_promotional_claim:
    "Remove every promotional, superlative and guarantee claim about any operator — cheapest, best, award-winning, guaranteed fares, always on time. Describe how to judge an option instead of asserting one is superior.",
  untrusted_citation:
    "Remove every URL from the body, and list in sources only URLs copied exactly from the approvedSources list. Replace an unusable citation with a relevant approved source that genuinely covers the point.",
  unverified_material_claim:
    "Each listed claim is not supported by any approved source. For each one: either cite an approved source that genuinely covers it, or qualify it so it no longer asserts a specific figure, or delete the statement from the body entirely. Do not invent a source and do not keep an unsupported figure.",
  undeclared_material_claim:
    "The body states checkable facts — money, times, durations, distances, percentages, capacities, licensing — that are not declared in claims. Declare every one of them in claims with a sourceUrl from approvedSources, or remove the statement from the body. Prefer writing with no specific figures at all.",
  unrecognised_transport_place:
    "The listed stations, airports, terminals or ports could not be recognised. Name only real ones, spelled as the operator spells them, or write the passage without naming them.",
  location_not_referenced:
    "The article must be clearly about the target location. Keep the same location and make the local context explicit and specific.",
  keyword_stuffing:
    "The location name is repeated too often. Reduce it to natural usage without weakening the local specificity.",
  image_not_verified:
    "No licensed image could be matched. Make the title and subject concrete and literal about the place so an openly licensed photograph of it can be found. Do not describe or credit an image yourself.",
  verification_failed:
    "Source verification failed: a declared source is not approved, or its URL is dead. Replace it with a relevant approved source that actually covers the claim relying on it, and re-check that the remaining claims are still supported.",
  verification_unverified:
    "Source verification could not be completed for the declared sources. Cite approved sources whose URLs are the stable, canonical pages for the information used.",
  score_below_threshold:
    "Several advisory weaknesses are holding the score down. Improve readability, structure and flow, sharpen the search-intent match of the title and metaDescription, and remove repetition.",
};

/** Turn the evaluator's failed checks into concrete corrective instructions. */
export function buildCorrectionInstructions(
  evaluation: DraftEvaluation,
  minScore: number = MIN_ARTICLE_QUALITY_SCORE,
): string[] {
  const instructions: string[] = [];

  for (const check of evaluation.blocking) {
    const instruction = CHECK_INSTRUCTIONS[check];

    if (instruction) {
      instructions.push(`[${check}] ${instruction}`);
    } else {
      // An unmapped check must still reach the model rather than being
      // silently dropped, or the revision cannot possibly fix it.
      instructions.push(
        `[${check}] This mandatory check failed. Correct the underlying problem it names.`,
      );
    }
  }

  if (evaluation.blocking.length === 0 && evaluation.score < minScore) {
    instructions.push(
      `[score_below_threshold] ${CHECK_INSTRUCTIONS.score_below_threshold}`,
    );
  }

  return instructions;
}

// --- Draft comparison ------------------------------------------------------

/**
 * How good a draft is, as a comparable tuple. Provenance outranks score on
 * purpose: a draft whose sources failed verification is never "better" than one
 * whose sources checked out, however well it scored.
 */
function rank(evaluation: DraftEvaluation) {
  const verificationRank =
    evaluation.verification.status === "verified"
      ? 2
      : evaluation.verification.status === "unverified"
        ? 1
        : 0;

  return [
    evaluation.pass ? 1 : 0,
    verificationRank,
    -evaluation.blocking.length,
    evaluation.score,
  ];
}

/** True when `candidate` is a strictly better draft than `incumbent`. */
export function isBetterDraft(
  candidate: DraftEvaluation,
  incumbent: DraftEvaluation | null,
): boolean {
  if (!incumbent) {
    return true;
  }

  const left = rank(candidate);
  const right = rank(incumbent);

  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] > right[i];
    }
  }

  // A tie keeps the incumbent: there is no reason to churn the stored draft.
  return false;
}

// --- Backoff ---------------------------------------------------------------

/**
 * Exponential backoff with full jitter, honouring the provider's own
 * `Retry-After` when it sent one. Jitter matters because the worker and the
 * route can both be retrying the same provider.
 */
export function backoffDelayMs(
  attempt: number,
  options: { retryAfterMs?: number; random?: () => number; baseMs?: number; capMs?: number } = {},
): number {
  const { retryAfterMs, random = Math.random, baseMs = 2_000, capMs = 60_000 } = options;

  if (typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(retryAfterMs, capMs);
  }

  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));

  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** Parse a `Retry-After` header, which may be seconds or an HTTP date. */
export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value.trim());

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const date = Date.parse(value);

  if (Number.isFinite(date)) {
    return Math.max(0, date - nowMs);
  }

  return undefined;
}

// --- The loop --------------------------------------------------------------

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Invariants a revision is not allowed to drift. The model is asked to keep
 * them and this enforces it, so a revision cannot quietly move the article to a
 * different place or break a canonical URL that is already published.
 */
export function preserveInvariants(revised: Article, original: Article): Article {
  return { ...revised, slug: original.slug };
}

export async function runImprovementLoop(
  deps: LoopDeps,
  options: LoopOptions = {},
): Promise<LoopResult> {
  const {
    maxRevisions = MAX_QUALITY_REVISIONS,
    maxProviderRetries = MAX_PROVIDER_RETRIES,
    budgetMs = QUALITY_CYCLE_BUDGET_MS,
    minScore = MIN_ARTICLE_QUALITY_SCORE,
    minCallBudgetMs = 0,
    resumeFrom = null,
  } = options;

  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const startedAt = now();

  const attempts: AttemptLog[] = [];
  let providerCalls = 0;
  let providerRetries = 0;
  let revisions = 0;
  let best: { article: Article; evaluation: DraftEvaluation } | null = null;
  let latest: { article: Article; evaluation: DraftEvaluation } | null = null;
  let lastError: { code: string; message?: string } | null = null;

  const elapsed = () => now() - startedAt;
  const budgetLeft = () => budgetMs - elapsed();

  const record = (entry: Omit<AttemptLog, "providerRetries" | "elapsedMs">) => {
    const full: AttemptLog = { ...entry, providerRetries, elapsedMs: elapsed() };
    attempts.push(full);
    deps.log?.(full);
  };

  /**
   * One provider call, retried only for transient failures and only while the
   * shared provider-retry budget and the cycle's time budget allow.
   */
  const callProvider = async (
    kind: "initial" | "revision",
    request: RevisionRequest | null,
  ): Promise<ProviderResult> => {
    for (;;) {
      // Never start a call the cycle cannot see through. The first call is
      // exempt: a cycle too short for even one attempt should still try, and
      // the caller's own timeout bounds it.
      if (providerCalls > 0 && budgetLeft() < minCallBudgetMs) {
        const result: ProviderResult = {
          ok: false,
          kind: "transient",
          code: "cycle_budget_exhausted",
          message: `${budgetLeft()}ms left, a provider call needs ${minCallBudgetMs}ms`,
        };

        lastError = { code: result.code, message: result.message };

        record({
          attempt: attempts.length + 1,
          kind,
          score: null,
          pass: false,
          blocking: [],
          verificationStatus: null,
          providerCode: result.code,
        });

        return result;
      }

      providerCalls += 1;

      // Renewed before every call, not just after every revision. A provider
      // timeout can be most of the processing lease on its own, so a lease
      // renewed only between revisions can expire mid-call and let a second
      // worker take over a draft this one is still revising.
      await deps.heartbeat?.();

      const result = request
        ? await deps.reviseDraft(request)
        : await deps.generateInitial();

      if (result.ok) {
        return result;
      }

      lastError = { code: result.code, message: result.message };

      if (result.kind === "permanent" || providerRetries >= maxProviderRetries) {
        record({
          attempt: attempts.length + 1,
          kind,
          score: null,
          pass: false,
          blocking: [],
          verificationStatus: null,
          providerCode: result.code,
        });

        return result;
      }

      const delay = backoffDelayMs(providerRetries, {
        retryAfterMs: result.retryAfterMs,
        random,
      });

      providerRetries += 1;

      record({
        attempt: attempts.length + 1,
        kind,
        score: null,
        pass: false,
        blocking: [],
        verificationStatus: null,
        providerCode: result.code,
      });

      // Waiting past the cycle budget is pointless: the next cycle can wait
      // instead, and the job already carries its own retry window.
      if (delay >= budgetLeft()) {
        return { ...result, kind: "transient" };
      }

      await sleep(delay);
    }
  };

  // --- First draft: generated, or carried over from an earlier cycle -------

  let current: Article;

  if (resumeFrom) {
    current = resumeFrom.article;
  } else {
    const initial = await callProvider("initial", null);

    if (!initial.ok) {
      return {
        outcome: initial.kind === "permanent" ? "terminal" : "no_draft",
        best: null,
        latest: null,
        revisions,
        providerRetries,
        lastError,
        attempts,
      };
    }

    current = initial.article;
  }

  const original = current;

  // --- Evaluate, improve, evaluate again ----------------------------------

  for (;;) {
    const evaluation = await deps.evaluate(current);
    const candidate = { article: current, evaluation };

    latest = candidate;

    if (isBetterDraft(evaluation, best?.evaluation ?? null)) {
      best = candidate;
    }

    record({
      attempt: attempts.length + 1,
      kind: revisions === 0 && !resumeFrom ? "initial" : "revision",
      score: evaluation.score,
      pass: evaluation.pass,
      blocking: evaluation.blocking,
      verificationStatus: evaluation.verification.status,
      providerCode: null,
    });

    if (evaluation.pass) {
      return {
        outcome: "passed",
        best,
        latest,
        revisions,
        providerRetries,
        lastError,
        attempts,
      };
    }

    if (revisions >= maxRevisions || budgetLeft() <= 0) {
      return {
        outcome: "retry_later",
        best,
        latest,
        revisions,
        providerRetries,
        lastError,
        attempts,
      };
    }

    revisions += 1;

    const result = await callProvider("revision", {
      draft: current,
      failures: evaluation.blocking,
      instructions: buildCorrectionInstructions(evaluation, minScore),
      evaluation,
    });

    if (!result.ok) {
      // The best draft so far is already captured, so a provider failure here
      // costs diagnosis only, never the article.
      return {
        outcome: result.kind === "permanent" ? "terminal" : "retry_later",
        best,
        latest,
        revisions,
        providerRetries,
        lastError,
        attempts,
      };
    }

    current = preserveInvariants(result.article, original);

    await deps.heartbeat?.();
  }
}
