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
  .transform((value) =>
    typeof value === "string" ? { text: value } : value,
  );

export const ArticleSchema = z.object({
  title: z.string().trim().min(25).max(100),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().trim().min(60).max(240),
  content: z.string().trim().min(1200).max(14000),
  metaDescription: z.string().trim().min(100).max(160),
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
