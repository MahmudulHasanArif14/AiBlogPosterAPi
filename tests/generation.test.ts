import assert from "node:assert/strict";
import { test, describe, afterEach } from "node:test";
import { ARTICLE_JSON_SCHEMA, ArticleSchema } from "../src/lib/article";
import { requestArticle, resetSchemaModeForTests } from "../src/lib/generation";

// The provider adapter is the boundary every generation failure arrives
// through, so it is tested against a stubbed `fetch`. No real provider request
// is ever made: these assertions are about how a response is classified, and a
// real call would add cost and flakiness without adding confidence.

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  resetSchemaModeForTests();
});

/** A complete article that satisfies ArticleSchema. */
function validArticle(overrides: Record<string, unknown> = {}) {
  return {
    title: "Getting to Gatwick Airport from East Grinstead by car",
    slug: "gatwick-airport-from-east-grinstead-by-car",
    excerpt:
      "What the drive from East Grinstead to Gatwick Airport actually involves, from choosing a route to where you can drop passengers off.",
    content:
      "This is a paragraph about the drive to the airport and what it involves. ".repeat(
        30,
      ),
    metaDescription:
      "How the drive from East Grinstead to Gatwick Airport works in practice, including route choice, timing and where to drop off.",
    claims: [],
    sources: [],
    category: "airport travel",
    tags: ["gatwick", "east grinstead"],
    ...overrides,
  };
}

type StubResponse = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Stub `fetch`, recording each request body the adapter sends. */
function stubFetch(responses: StubResponse[]) {
  const calls: Record<string, unknown>[] = [];
  let index = 0;

  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));

    const spec = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = spec.status ?? 200;
    const text = JSON.stringify(spec.body ?? {});

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => spec.headers?.[name.toLowerCase()] ?? null,
      },
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  }) as unknown as typeof fetch;

  return calls;
}

/** A provider completion wrapping `content`. */
function completion(
  content: string,
  finishReason = "stop",
  usage: Record<string, unknown> = {},
) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: { completion_tokens: 1300, ...usage },
  };
}

const call = () => requestArticle("prompt", "test/model", "test-key");

/**
 * An article serialised and then cut off mid-string, the way a completion that
 * runs out of budget arrives. Derived from the real JSON's length so it stays
 * genuinely incomplete however the fixture changes.
 */
function truncatedArticleJson() {
  const full = JSON.stringify(validArticle());
  const partial = full.slice(0, Math.floor(full.length * 0.6));

  assert.throws(() => JSON.parse(partial), "fixture must be incomplete JSON");

  return partial;
}

describe("requestArticle: structured output", () => {
  test("a valid article is accepted", async () => {
    stubFetch([{ body: completion(JSON.stringify(validArticle())) }]);

    const result = await call();

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.article.title.length >= 25);
  });

  test("the request constrains output with the article JSON schema", async () => {
    const calls = stubFetch([
      { body: completion(JSON.stringify(validArticle())) },
    ]);

    await call();

    assert.deepEqual(calls[0].response_format, {
      type: "json_schema",
      json_schema: ARTICLE_JSON_SCHEMA,
    });
  });

  test("a provider that rejects the schema falls back to plain JSON mode", async () => {
    const calls = stubFetch([
      {
        status: 400,
        body: {
          error: { message: "response_format json_schema is not supported" },
        },
      },
      { body: completion(JSON.stringify(validArticle())) },
    ]);

    const result = await call();

    assert.equal(result.ok, true);
    assert.equal(
      (calls[0].response_format as { type: string }).type,
      "json_schema",
    );
    assert.deepEqual(calls[1].response_format, { type: "json_object" });
  });

  test("the fallback is remembered, so later calls do not re-probe the schema", async () => {
    stubFetch([
      { status: 400, body: { error: { message: "unsupported response_format" } } },
      { body: completion(JSON.stringify(validArticle())) },
    ]);
    await call();

    const calls = stubFetch([
      { body: completion(JSON.stringify(validArticle())) },
    ]);
    await call();

    assert.deepEqual(calls[0].response_format, { type: "json_object" });
  });

  test("a 4xx unrelated to the response format stays permanent", async () => {
    stubFetch([
      { status: 401, body: { error: { message: "No auth credentials found" } } },
    ]);

    const result = await call();

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.kind === "permanent");
    assert.ok(!result.ok && result.code === "provider_request_rejected");
  });
});

describe("requestArticle: failure classification", () => {
  test("empty provider output is rejected", async () => {
    stubFetch([{ body: completion("") }]);

    const result = await call();

    assert.ok(!result.ok && result.code === "invalid_article_structure");
  });

  test("an exhausted budget with no content is reported as truncation", async () => {
    stubFetch([
      {
        body: completion("", "length", {
          completion_tokens: 32_000,
          completion_tokens_details: { reasoning_tokens: 32_000 },
        }),
      },
    ]);

    const result = await call();

    assert.ok(!result.ok && result.code === "provider_output_truncated");
    assert.ok(!result.ok && result.kind === "transient");
  });

  test("JSON cut off mid-article is truncation, not a malformed article", async () => {
    const partial = truncatedArticleJson();

    stubFetch([{ body: completion(partial, "length") }]);

    const result = await call();

    // The distinction matters: truncation is a token-budget problem, while
    // invalid_article_structure sends the article back to the model as though
    // its writing were at fault.
    assert.ok(!result.ok && result.code === "provider_output_truncated");
    assert.ok(
      !result.ok &&
        (result.message ?? "").includes(`content_length=${partial.length}`),
    );
  });

  test("truncated output is never repaired into a valid article", async () => {
    stubFetch([{ body: completion(truncatedArticleJson(), "length") }]);

    assert.equal((await call()).ok, false);
  });

  test("malformed JSON that was not truncated is a structure failure", async () => {
    stubFetch([{ body: completion("{ not json at all", "stop") }]);

    const result = await call();

    assert.ok(!result.ok && result.code === "invalid_article_structure");
    assert.ok(!result.ok && result.kind === "transient");
  });

  test("valid JSON that fails the article schema is rejected", async () => {
    stubFetch([
      { body: completion(JSON.stringify(validArticle({ title: "too short" }))) },
    ]);

    const result = await call();

    assert.ok(!result.ok && result.code === "invalid_article_structure");
    assert.ok(!result.ok && (result.message ?? "").includes("title"));
  });

  test("an unexpected provider response structure is rejected safely", async () => {
    stubFetch([{ body: { unexpected: true } }]);

    const result = await call();

    assert.ok(!result.ok && result.code === "invalid_article_structure");
  });

  test("a network failure or timeout is transient", async () => {
    globalThis.fetch = (async () => {
      throw new Error("aborted");
    }) as unknown as typeof fetch;

    const result = await call();

    assert.ok(!result.ok && result.code === "provider_timeout");
    assert.ok(!result.ok && result.kind === "transient");
  });

  test("a rate limit is transient and carries Retry-After", async () => {
    stubFetch([{ status: 429, body: {}, headers: { "retry-after": "30" } }]);

    const result = await call();

    assert.ok(!result.ok && result.code === "provider_rate_limit");
    assert.ok(!result.ok && result.kind === "transient");
    assert.ok(!result.ok && result.retryAfterMs === 30_000);
  });

  test("a provider 5xx is transient", async () => {
    stubFetch([{ status: 503, body: {} }]);

    const result = await call();

    assert.ok(!result.ok && result.kind === "transient");
    assert.ok(!result.ok && result.code === "provider_error");
  });
});

describe("requestArticle: metadata length", () => {
  test("a slightly over-long meta description is trimmed, not re-rolled", async () => {
    const meta =
      "How the drive from East Grinstead to Gatwick Airport actually works in practice, including which route to choose, when to set off and exactly where you are allowed to drop passengers off.";

    assert.ok(meta.length > 160);
    stubFetch([
      {
        body: completion(JSON.stringify(validArticle({ metaDescription: meta }))),
      },
    ]);

    const result = await call();

    assert.equal(result.ok, true);
    assert.ok(result.ok && result.article.metaDescription.length <= 160);
    assert.ok(result.ok && result.article.metaDescription.length >= 100);
  });

  test("a meta description below the 100-character floor is still rejected", async () => {
    stubFetch([
      {
        body: completion(
          JSON.stringify(validArticle({ metaDescription: "Far too short." })),
        ),
      },
    ]);

    const result = await call();

    assert.ok(!result.ok && result.code === "invalid_article_structure");
    assert.ok(!result.ok && (result.message ?? "").includes("metaDescription"));
  });

  test("a meta description at exactly 160 characters is accepted unchanged", async () => {
    const meta =
      "Driving from East Grinstead to Gatwick Airport is straightforward. ".repeat(
        3,
      ).slice(0, 160);

    assert.equal(meta.length, 160);
    stubFetch([
      {
        body: completion(JSON.stringify(validArticle({ metaDescription: meta }))),
      },
    ]);

    const result = await call();

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.article.metaDescription, meta);
  });

  test("the schema sent to the provider asks for a margin under the hard limit", () => {
    assert.equal(
      ARTICLE_JSON_SCHEMA.schema.properties.metaDescription.maxLength,
      155,
    );
  });
});

// The provider schema and ArticleSchema are two statements of one contract, in
// two languages, and nothing but these tests stops them drifting apart. A
// provider schema looser than the validator lets the model produce articles
// that fail validation -- the exact failure this work set out to remove.
describe("ARTICLE_JSON_SCHEMA agrees with ArticleSchema", () => {
  const props = ARTICLE_JSON_SCHEMA.schema.properties as Record<
    string,
    { minLength?: number; maxLength?: number; maxItems?: number }
  >;

  test("both describe exactly the same set of fields", () => {
    assert.deepEqual(
      Object.keys(props).sort(),
      Object.keys(ArticleSchema.shape).sort(),
    );
  });

  test("strict mode requires every field it declares", () => {
    assert.deepEqual(
      [...ARTICLE_JSON_SCHEMA.schema.required].sort(),
      Object.keys(props).sort(),
    );
    assert.equal(ARTICLE_JSON_SCHEMA.schema.additionalProperties, false);
    assert.equal(ARTICLE_JSON_SCHEMA.strict, true);
  });

  // Each field is filled to the provider schema's own boundary and handed to
  // the validator. Anything the provider is allowed to emit must be accepted.
  for (const field of ["title", "excerpt", "content", "metaDescription"]) {
    test(`a ${field} at the provider schema's bounds satisfies ArticleSchema`, () => {
      const { minLength, maxLength } = props[field];

      assert.ok(typeof minLength === "number" && typeof maxLength === "number");

      for (const length of [minLength, maxLength]) {
        // Word-separated, and never ending in whitespace: ArticleSchema trims
        // before measuring, while the provider schema counts raw characters,
        // so a boundary-length string with a trailing space is one character
        // short by the time the validator sees it.
        const filler = `${"word ".repeat(Math.ceil(length / 5)).slice(0, length - 1)}x`;

        assert.equal(filler.length, length);
        assert.equal(filler.trim().length, length);
        const parsed = ArticleSchema.safeParse(
          validArticle({ [field]: filler }),
        );

        assert.equal(
          parsed.success,
          true,
          `${field} of length ${length} was rejected: ${
            parsed.success ? "" : JSON.stringify(parsed.error.issues)
          }`,
        );
      }
    });
  }

  test("the maximum number of tags and claims the provider may emit is accepted", () => {
    const parsed = ArticleSchema.safeParse(
      validArticle({
        tags: Array.from({ length: props.tags.maxItems ?? 0 }, (_, i) => `tag${i}`),
        claims: Array.from({ length: props.claims.maxItems ?? 0 }, () => ({
          text: "A declared claim with a source behind it.",
          sourceUrl: "https://www.gatwickairport.com/",
        })),
      }),
    );

    assert.equal(parsed.success, true);
  });

  test("the provider's meta description ceiling sits under the validator's", () => {
    // 155 < 160 is the safety margin. If the provider schema ever reached 160
    // there would be no room left for a model that miscounts by a word.
    assert.ok((props.metaDescription.maxLength ?? 0) < 160);
  });
});
