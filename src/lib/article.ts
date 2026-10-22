import { z } from "zod";

// A material factual claim the generator says it made. The provider may return
// either a bare string (the original contract) or an object carrying the source
// it relied on. Both normalise to the same shape so existing prompts keep
// working while newer ones can supply provenance.
const ClaimInput = z
  .union([
    z.string().trim().min(5).max(500),
    z.object({
      text: z.string().trim().min(5).max(500),
      sourceUrl: z.string().trim().url().max(500).optional(),
    }),
  ])
  .transform((value) => (typeof value === "string" ? { text: value } : value));

export const ArticleSchema = z.object({
  title: z.string().trim().min(25).max(100),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().trim().min(30).max(240),
  content: z.string().trim().min(800).max(14000),
  metaDescription: z.string().trim().min(70).max(160),
  claims: z.array(ClaimInput).max(20).default([]),
  category: z.string().trim().min(3).max(60).optional(),
  tags: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
  sources: z.array(z.string().trim().url().max(500)).max(12).default([]),
});

export type Article = z.infer<typeof ArticleSchema>;
export type ArticleClaim = Article["claims"][number];

export function htmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeSlug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

// Must match the posts.title_normalized generated column exactly, otherwise the
// application's duplicate check and the database's unique index disagree.
export function normalizeTitle(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function wordCount(value: string) {
  const words = value.trim().match(/[\p{L}\p{N}'’-]+/gu);
  return words ? words.length : 0;
}

export function readingMinutes(value: string) {
  // 220 words per minute, rounded up, never less than one.
  return Math.max(1, Math.ceil(wordCount(value) / 220));
}

// The provider repeatedly returns a complete, good article whose
// metaDescription overruns 160 characters by a handful of words. Throwing the
// whole draft away over that costs a full generation attempt (~100s) to fix
// something a word-boundary trim resolves exactly. Only the meta description is
// trimmed: it is a summary, so a clean cut at a word boundary stays true, and
// the schema still rejects anything that lands under the 100-character floor.
export function normaliseArticlePayload(payload: unknown) {
  if (payload === null || typeof payload !== "object") return payload;

  const record = payload as Record<string, unknown>;
  const meta = record.metaDescription;
  if (typeof meta !== "string") return payload;

  const trimmed = meta.trim();
  if (trimmed.length <= 160) return payload;

  const cut = trimmed.slice(0, 160);
  const lastSpace = cut.lastIndexOf(" ");
  const shortened = (lastSpace > 100 ? cut.slice(0, lastSpace) : cut).replace(
    /[\s,;:—-]+$/,
    "",
  );

  return { ...record, metaDescription: shortened };
}

/**
 * The provider-side mirror of `ArticleSchema`, sent as an OpenRouter
 * `json_schema` response format.
 *
 * OpenRouter reports `structured_outputs` among the configured model's
 * supported parameters, which constrains generation to this shape instead of
 * merely asking for "a JSON object". That is what stops the two failures the
 * prompt alone could not: a missing or misnamed key, and a `metaDescription`
 * that overruns 160 characters.
 *
 * `strict` mode requires every property to be listed in `required` and
 * `additionalProperties` to be false, so fields optional in Zod (`category`)
 * are required here. That is a tightening, not a conflict: Zod still accepts
 * what this produces. Length bounds are included because the backing provider
 * may enforce them, but they are deliberately not relied upon — the response
 * is still normalised and re-validated against `ArticleSchema`, and the caller
 * falls back to plain JSON mode if the provider rejects this schema.
 */
export const ARTICLE_JSON_SCHEMA = {
  name: "article",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "slug",
      "excerpt",
      "content",
      "metaDescription",
      "claims",
      "sources",
      "category",
      "tags",
    ],
    properties: {
      title: { type: "string", minLength: 25, maxLength: 100 },
      slug: {
        type: "string",
        pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$",
        minLength: 3,
        maxLength: 120,
      },
      excerpt: { type: "string", minLength: 30, maxLength: 240 },
      content: { type: "string", minLength: 800, maxLength: 14000 },
      // 155 rather than 160: the hard limit is 160, and leaving the model a
      // margin is what keeps a good article from failing on its meta tag.
      metaDescription: { type: "string", minLength: 70, maxLength: 155 },
      claims: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 5, maxLength: 500 },
            sourceUrl: { type: "string", maxLength: 500 },
          },
        },
      },
      // No `format: "uri"` on the items: `format` is the JSON Schema keyword
      // most often unsupported by a constrained-decoding backend, and a
      // rejection here would cost schema mode for the whole process. Zod still
      // enforces `.url()`, and `verifySources` independently refuses anything
      // that is not an approved, reachable URL.
      sources: {
        type: "array",
        maxItems: 12,
        items: { type: "string", maxLength: 500 },
      },
      category: { type: "string", minLength: 3, maxLength: 60 },
      tags: {
        type: "array",
        maxItems: 6,
        items: { type: "string", minLength: 2, maxLength: 40 },
      },
    },
  },
} as const;
