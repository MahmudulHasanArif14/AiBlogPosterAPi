import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ArticleSchema, type Article } from "../src/lib/article";
import {
  backoffDelayMs,
  buildCorrectionInstructions,
  isBetterDraft,
  parseRetryAfter,
  preserveInvariants,
  runImprovementLoop,
  type DraftEvaluation,
  type LoopDeps,
  type ProviderResult,
} from "../src/lib/revision";

/**
 * These tests drive the improvement loop with a scripted provider and a
 * scripted evaluator, so every branch of the state machine is reachable without
 * a network call or a database.
 *
 * The real evaluator is covered by quality.test.ts. What is pinned down here is
 * the loop's contract: that a failing draft is revised with its own failure
 * details, that the two retry budgets are independent, that the best draft is
 * never lost, and that no exit path can present a failing article as passing.
 */

function article(overrides: Record<string, unknown> = {}): Article {
  const paragraph = (seed: string) =>
    Array.from(
      { length: 5 },
      (_, i) =>
        `${seed} Working out the timing before you travel is what separates a calm departure from a scramble, especially when other people are relying on you, point ${i + 1}.`,
    ).join(" ");

  return ArticleSchema.parse({
    title: "Planning a calmer airport run out of Brighton",
    slug: "planning-a-calmer-airport-run-out-of-brighton",
    excerpt:
      "How to build a sensible margin into an early airport journey, and the handful of things worth checking the night before you travel.",
    content: [
      paragraph("Travelling out of Brighton towards the airport rewards preparation."),
      paragraph("Think about which part of the journey is least predictable."),
      paragraph("Luggage changes the calculation more than most people expect."),
      paragraph("Finally, write down the details you will need when you are tired."),
    ].join("\n\n"),
    metaDescription:
      "Practical guidance on planning an early airport journey from Brighton, including what to check the night before and how much margin to allow yourself.",
    claims: [],
    sources: [],
    tags: ["airport", "planning"],
    ...overrides,
  });
}

function evaluation(overrides: Partial<DraftEvaluation> = {}): DraftEvaluation {
  const blocking = overrides.blocking ?? [];
  const score = overrides.score ?? 100;

  return {
    score,
    pass: blocking.length === 0 && score >= 85,
    blocking,
    quality: {
      pass: blocking.length === 0 && score >= 85,
      score,
      reasons: blocking,
      warnings: [],
      details: {
        words: 700,
        maxContentSimilarity: 0,
        mostSimilarSlug: null,
        unverifiedClaims: [],
        verifiedClaims: [],
        unrecognisedPlaces: [],
        untrustedCitations: [],
        undeclaredMaterialSentences: [],
      },
    },
    verification: { status: "verified", checks: [], reasons: [] },
    imageOk: true,
    ...overrides,
  };
}

/**
 * A loop harness. `providerScript` is consumed one entry per provider call and
 * `evaluationScript` one entry per evaluation, so a test reads as the exact
 * sequence of events it is describing.
 */
function harness(options: {
  providerScript: ProviderResult[];
  evaluationScript: DraftEvaluation[];
}) {
  const providerCalls: ("initial" | "revision")[] = [];
  const revisionRequests: { failures: string[]; instructions: string[]; draft: Article }[] =
    [];
  const evaluated: Article[] = [];
  const sleeps: number[] = [];
  let heartbeats = 0;
  let clock = 0;

  const nextProvider = (): ProviderResult => {
    const result = options.providerScript.shift();

    if (!result) {
      throw new Error("provider called more times than the test scripted");
    }

    return result;
  };

  const deps: LoopDeps = {
    generateInitial: async () => {
      providerCalls.push("initial");
      return nextProvider();
    },
    reviseDraft: async (request) => {
      providerCalls.push("revision");
      revisionRequests.push({
        failures: request.failures,
        instructions: request.instructions,
        draft: request.draft,
      });
      return nextProvider();
    },
    evaluate: async (draft) => {
      evaluated.push(draft);

      const result = options.evaluationScript.shift();

      if (!result) {
        throw new Error("evaluate called more times than the test scripted");
      }

      return result;
    },
    heartbeat: async () => {
      heartbeats += 1;
    },
    now: () => clock,
    // Time only advances when the loop waits, so the wall-clock budget is
    // deterministic and a test never actually sleeps.
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    random: () => 0.5,
  };

  return {
    deps,
    providerCalls,
    revisionRequests,
    evaluated,
    sleeps,
    get heartbeats() {
      return heartbeats;
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("runImprovementLoop", () => {
  test("a first draft that passes is accepted without any revision", async () => {
    const draft = article();
    const h = harness({
      providerScript: [{ ok: true, article: draft }],
      evaluationScript: [evaluation({ score: 92 })],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");
    assert.equal(result.revisions, 0);
    assert.equal(result.providerRetries, 0);
    assert.equal(h.providerCalls.length, 1);
    assert.equal(result.best?.article, draft);
  });

  test("a draft scoring below the threshold passes after one revision", async () => {
    const first = article({ title: "A first draft that scores below the bar" });
    const second = article({ title: "A second draft that answers the question well" });

    const h = harness({
      providerScript: [
        { ok: true, article: first },
        { ok: true, article: second },
      ],
      evaluationScript: [
        evaluation({ score: 82, blocking: [] }),
        evaluation({ score: 97 }),
      ],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");
    assert.equal(result.revisions, 1);
    assert.equal(result.best?.evaluation.score, 97);
    assert.deepEqual(h.providerCalls, ["initial", "revision"]);

    // A score-only failure still has to tell the model what to improve.
    assert.match(
      h.revisionRequests[0].instructions.join("\n"),
      /score_below_threshold/,
    );
  });

  test("revisions continue until the article passes, each one carrying the previous draft", async () => {
    const drafts = [
      article({ title: "First attempt at the Brighton airport question" }),
      article({ title: "Second attempt at the Brighton airport question" }),
      article({ title: "Third attempt at the Brighton airport question" }),
    ];

    const h = harness({
      providerScript: drafts.map((a) => ({ ok: true, article: a }) as ProviderResult),
      evaluationScript: [
        evaluation({ score: 30, blocking: ["content_too_short"] }),
        evaluation({ score: 65, blocking: ["meta_description_length"] }),
        evaluation({ score: 100 }),
      ],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");
    assert.equal(result.revisions, 2);
    assert.deepEqual(h.revisionRequests[0].failures, ["content_too_short"]);
    assert.deepEqual(h.revisionRequests[1].failures, ["meta_description_length"]);

    // Each revision improves the *previous* draft rather than starting over.
    assert.equal(h.revisionRequests[0].draft.title, drafts[0].title);
    assert.equal(h.revisionRequests[1].draft.title, drafts[1].title);

    // The lease is renewed before every provider call and again after every
    // revision, so a long cycle is never stolen by a second worker: three
    // calls plus two revisions.
    assert.equal(h.heartbeats, 5);
  });

  test("a draft that never reaches the threshold stops at the revision limit and keeps its best draft", async () => {
    const drafts = Array.from({ length: 4 }, (_, i) =>
      article({ title: `Attempt number ${i + 1} at an article that cannot pass` }),
    );

    const h = harness({
      providerScript: drafts
        .slice(1)
        .map((a) => ({ ok: true, article: a }) as ProviderResult),
      evaluationScript: [
        evaluation({ score: 50, blocking: ["content_too_short"] }),
        evaluation({ score: 80, blocking: [] }),
        evaluation({ score: 60, blocking: [] }),
        evaluation({ score: 70, blocking: [] }),
      ],
    });

    const result = await runImprovementLoop(h.deps, {
      maxRevisions: 3,
      resumeFrom: { article: drafts[0] },
    });

    assert.equal(result.outcome, "retry_later");
    assert.equal(result.revisions, 3);

    // The best draft is the 80, not the 70 that happened to come last.
    assert.equal(result.best?.evaluation.score, 80);
    assert.equal(result.latest?.evaluation.score, 70);
    assert.notEqual(result.best?.article, result.latest?.article);
  });

  test("a high score never passes while factual verification has failed", async () => {
    const h = harness({
      providerScript: [
        { ok: true, article: article() },
        { ok: true, article: article({ title: "A revision with sources that check out" }) },
      ],
      evaluationScript: [
        evaluation({
          score: 100,
          blocking: ["verification_failed"],
          verification: {
            status: "failed",
            checks: [
              {
                url: "https://example.invalid/gone",
                sourceName: null,
                status: 404,
                outcome: "missing",
              },
            ],
            reasons: ["source_url_dead"],
          },
        }),
        evaluation({ score: 88 }),
      ],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");
    assert.equal(result.revisions, 1);

    // The 88 with verified sources outranks the 100 whose sources failed.
    assert.equal(result.best?.evaluation.score, 88);
    assert.match(
      h.revisionRequests[0].instructions.join("\n"),
      /verification_failed/,
    );
  });

  test("unsupported claims are named in the correction and re-verified", async () => {
    const h = harness({
      providerScript: [
        { ok: true, article: article() },
        { ok: true, article: article({ title: "A revision with the figure removed" }) },
      ],
      evaluationScript: [
        evaluation({
          score: 65,
          blocking: ["unverified_material_claim"],
          quality: {
            ...evaluation().quality,
            score: 65,
            reasons: ["unverified_material_claim"],
            details: {
              ...evaluation().quality.details,
              unverifiedClaims: ["A taxi to the airport costs about £45."],
            },
          },
        }),
        evaluation({ score: 95 }),
      ],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");

    const instructions = h.revisionRequests[0].instructions.join("\n");

    assert.match(instructions, /unverified_material_claim/);
    assert.match(instructions, /must be removed from the article|delete the statement/i);
    // The correction must never ask for a fabricated source.
    assert.match(instructions, /Do not invent a source/);

    // The revision is put through the evaluator again rather than trusted.
    assert.equal(h.evaluated.length, 2);
  });

  test("a rate limit is retried on the provider budget, not the revision budget", async () => {
    const h = harness({
      providerScript: [
        {
          ok: false,
          kind: "transient",
          code: "provider_rate_limit",
          retryAfterMs: 4_000,
        },
        { ok: true, article: article() },
      ],
      evaluationScript: [evaluation({ score: 90 })],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "passed");
    // The rate limit cost a provider retry and no revision.
    assert.equal(result.providerRetries, 1);
    assert.equal(result.revisions, 0);
    // Retry-After was honoured rather than overridden by the backoff curve.
    assert.deepEqual(h.sleeps, [4_000]);
  });

  test("a permanent provider error is terminal and is not retried", async () => {
    const h = harness({
      providerScript: [
        { ok: false, kind: "permanent", code: "provider_request_rejected" },
      ],
      evaluationScript: [],
    });

    const result = await runImprovementLoop(h.deps);

    assert.equal(result.outcome, "terminal");
    assert.equal(result.best, null);
    assert.equal(result.providerRetries, 0);
    assert.equal(h.providerCalls.length, 1);
    assert.equal(result.lastError?.code, "provider_request_rejected");
  });

  test("malformed provider output is retried up to the provider budget, then gives up", async () => {
    const h = harness({
      providerScript: Array.from(
        { length: 3 },
        () =>
          ({
            ok: false,
            kind: "transient",
            code: "invalid_article_structure",
          }) as ProviderResult,
      ),
      evaluationScript: [],
    });

    const result = await runImprovementLoop(h.deps, { maxProviderRetries: 2 });

    assert.equal(result.outcome, "no_draft");
    assert.equal(result.providerRetries, 2);
    assert.equal(h.providerCalls.length, 3);
    assert.equal(result.lastError?.code, "invalid_article_structure");
  });

  test("a provider failure mid-revision keeps the best draft and asks for another cycle", async () => {
    const h = harness({
      providerScript: [
        { ok: true, article: article() },
        { ok: false, kind: "transient", code: "provider_timeout" },
        { ok: false, kind: "transient", code: "provider_timeout" },
      ],
      evaluationScript: [evaluation({ score: 70, blocking: [] })],
    });

    const result = await runImprovementLoop(h.deps, { maxProviderRetries: 1 });

    assert.equal(result.outcome, "retry_later");
    assert.equal(result.best?.evaluation.score, 70);
    assert.equal(result.revisions, 1);
  });

  test("a resumed cycle improves the stored draft instead of generating a new article", async () => {
    const stored = article({ title: "The draft an earlier cycle left behind" });

    const h = harness({
      providerScript: [
        { ok: true, article: article({ title: "The revision that finally passes" }) },
      ],
      evaluationScript: [
        evaluation({ score: 60, blocking: ["content_too_short"] }),
        evaluation({ score: 90 }),
      ],
    });

    const result = await runImprovementLoop(h.deps, {
      resumeFrom: { article: stored },
    });

    assert.equal(result.outcome, "passed");
    // No initial generation: nothing new was commissioned, so no second
    // rotation turn could be consumed for work already done.
    assert.deepEqual(h.providerCalls, ["revision"]);
    assert.equal(h.evaluated[0], stored);
  });

  test("the wall-clock budget ends the cycle rather than the process", async () => {
    const h = harness({
      providerScript: [{ ok: true, article: article() }],
      evaluationScript: [evaluation({ score: 40, blocking: ["content_too_short"] })],
    });

    const result = await runImprovementLoop(
      {
        ...h.deps,
        // The first evaluation alone uses the whole cycle budget, so there is
        // no time left to revise.
        evaluate: async (draft) => {
          h.advance(31_000);
          return h.deps.evaluate(draft);
        },
      },
      { budgetMs: 30_000 },
    );

    assert.equal(result.outcome, "retry_later");
    assert.equal(result.revisions, 0);
    assert.equal(result.best?.evaluation.score, 40);
  });

  test("a provider call is not started when the budget cannot see it through", async () => {
    const h = harness({
      providerScript: [{ ok: true, article: article() }],
      evaluationScript: [evaluation({ score: 40, blocking: ["content_too_short"] })],
    });

    const result = await runImprovementLoop(
      {
        ...h.deps,
        evaluate: async (draft) => {
          h.advance(100_000);
          return h.deps.evaluate(draft);
        },
      },
      // 200s left once the first draft is evaluated, but a call needs 240s.
      { budgetMs: 300_000, minCallBudgetMs: 240_000 },
    );

    assert.equal(result.outcome, "retry_later");
    // The revision was counted as attempted but no second call was issued, so
    // the cycle cannot overrun its budget by a whole provider timeout.
    assert.deepEqual(h.providerCalls, ["initial"]);
    assert.equal(result.lastError?.code, "cycle_budget_exhausted");
    assert.equal(result.best?.evaluation.score, 40);
  });

  test("the first call of a cycle is always attempted, however tight the budget", async () => {
    const h = harness({
      providerScript: [{ ok: true, article: article() }],
      evaluationScript: [evaluation({ score: 95 })],
    });

    const result = await runImprovementLoop(h.deps, {
      budgetMs: 0,
      minCallBudgetMs: 240_000,
    });

    assert.equal(result.outcome, "passed");
    assert.deepEqual(h.providerCalls, ["initial"]);
  });

  test("a retry whose backoff outlasts the cycle budget defers instead of sleeping", async () => {
    const h = harness({
      providerScript: [
        {
          ok: false,
          kind: "transient",
          code: "provider_rate_limit",
          retryAfterMs: 600_000,
        },
      ],
      evaluationScript: [],
    });

    const result = await runImprovementLoop(h.deps, { budgetMs: 60_000 });

    assert.equal(result.outcome, "no_draft");
    assert.deepEqual(h.sleeps, []);
  });

  test("every attempt is logged with its score, failed checks and provider error", async () => {
    const logged: string[] = [];

    const h = harness({
      providerScript: [
        { ok: false, kind: "transient", code: "provider_rate_limit" },
        { ok: true, article: article() },
      ],
      evaluationScript: [evaluation({ score: 95 })],
    });

    const result = await runImprovementLoop(
      { ...h.deps, log: (entry) => logged.push(`${entry.kind}:${entry.providerCode ?? entry.score}`) },
      {},
    );

    assert.equal(result.outcome, "passed");
    assert.deepEqual(logged, ["initial:provider_rate_limit", "initial:95"]);
    assert.equal(result.attempts.length, 2);
  });

  test("a revision cannot silently change the slug", () => {
    const original = article();
    const revised = article({
      title: "A revision that wandered off to a different slug entirely",
      slug: "a-revision-that-wandered-off",
    });

    const kept = preserveInvariants(revised, original);

    assert.equal(kept.slug, original.slug);
    assert.equal(kept.title, revised.title);
  });

  test("a resumed cycle's revisions keep the stored draft's slug", async () => {
    const stored = article({ slug: "the-canonical-slug-already-recorded" });

    const h = harness({
      providerScript: [
        { ok: true, article: article({ slug: "a-brand-new-slug" }) },
      ],
      evaluationScript: [
        evaluation({ score: 40, blocking: ["content_too_short"] }),
        evaluation({ score: 90 }),
      ],
    });

    const result = await runImprovementLoop(h.deps, {
      resumeFrom: { article: stored },
    });

    assert.equal(result.best?.article.slug, "the-canonical-slug-already-recorded");
  });
});

describe("isBetterDraft", () => {
  test("the first draft seen is always the incumbent", () => {
    assert.equal(isBetterDraft(evaluation({ score: 10 }), null), true);
  });

  test("a passing draft beats a higher-scoring one that does not pass", () => {
    const passing = evaluation({ score: 86 });
    const failing = evaluation({ score: 100, blocking: ["image_not_verified"] });

    assert.equal(isBetterDraft(passing, failing), true);
    assert.equal(isBetterDraft(failing, passing), false);
  });

  test("a verified draft is never displaced by an unverified one that scores higher", () => {
    const verified = evaluation({ score: 70, blocking: ["content_too_short"] });
    const unverified = evaluation({
      score: 95,
      blocking: ["verification_failed"],
      verification: { status: "failed", checks: [], reasons: ["source_url_dead"] },
    });

    assert.equal(isBetterDraft(unverified, verified), false);
    assert.equal(isBetterDraft(verified, unverified), true);
  });

  test("fewer failed checks wins before the score does", () => {
    const fewer = evaluation({ score: 65, blocking: ["content_too_short"] });
    const more = evaluation({
      score: 65,
      blocking: ["content_too_short", "meta_description_length"],
    });

    assert.equal(isBetterDraft(fewer, more), true);
    assert.equal(isBetterDraft(more, fewer), false);
  });

  test("a tie keeps the incumbent so the stored draft is not churned", () => {
    assert.equal(isBetterDraft(evaluation({ score: 80 }), evaluation({ score: 80 })), false);
  });
});

describe("buildCorrectionInstructions", () => {
  test("every failed check becomes one actionable instruction", () => {
    const instructions = buildCorrectionInstructions(
      evaluation({
        score: 30,
        blocking: ["content_too_short", "unsupported_promotional_claim"],
      }),
    );

    assert.equal(instructions.length, 2);
    assert.match(instructions[0], /^\[content_too_short\]/);
    assert.match(instructions[1], /^\[unsupported_promotional_claim\]/);
  });

  test("an unmapped check is still passed through rather than dropped", () => {
    const instructions = buildCorrectionInstructions(
      evaluation({ score: 50, blocking: ["some_future_check"] }),
    );

    assert.equal(instructions.length, 1);
    assert.match(instructions[0], /^\[some_future_check\]/);
  });

  test("no instruction ever asks the model to fake a check or a source", () => {
    const instructions = buildCorrectionInstructions(
      evaluation({
        score: 10,
        blocking: [
          "content_too_short",
          "unverified_material_claim",
          "undeclared_material_claim",
          "untrusted_citation",
          "verification_failed",
          "image_not_verified",
          "unsupported_promotional_claim",
          "unrecognised_transport_place",
        ],
      }),
    );

    const all = instructions.join("\n");

    // Fabrication is only ever mentioned in order to forbid it.
    for (const match of all.matchAll(/(.{0,12})\b(invent|fabricate|make up)\b/gi)) {
      assert.match(
        match[1],
        /do not /i,
        `fabrication mentioned without a prohibition: ${JSON.stringify(match[0])}`,
      );
    }

    assert.doesNotMatch(
      all,
      /pretend|mark .{0,20}as passed|raise the score|report .{0,20}as passing/i,
    );
  });
});

describe("backoff", () => {
  test("Retry-After in seconds is honoured", () => {
    assert.equal(parseRetryAfter("30"), 30_000);
  });

  test("Retry-After as an HTTP date is honoured", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");

    assert.equal(
      parseRetryAfter("Thu, 22 Oct 2026 12:00:30 GMT", now),
      30_000,
    );
  });

  test("a missing or nonsense Retry-After falls back to the backoff curve", () => {
    assert.equal(parseRetryAfter(null), undefined);
    assert.equal(parseRetryAfter("soon"), undefined);
  });

  test("the delay grows exponentially and is jittered", () => {
    const low = backoffDelayMs(0, { random: () => 0 });
    const high = backoffDelayMs(0, { random: () => 1 });

    assert.ok(low < high, "jitter should widen the range");
    assert.ok(backoffDelayMs(3, { random: () => 1 }) > high);
  });

  test("the delay is capped", () => {
    assert.ok(backoffDelayMs(20, { random: () => 1 }) <= 60_000);
    assert.equal(backoffDelayMs(0, { retryAfterMs: 999_999_999 }), 60_000);
  });
});
