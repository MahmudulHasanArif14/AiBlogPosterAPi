import { z } from "zod";
export const ArticleSchema = z.object({
  title: z.string().trim().min(25).max(100),
  slug: z.string().trim().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  excerpt: z.string().trim().min(60).max(240),
  content: z.string().trim().min(1200).max(14000),
  metaDescription: z.string().trim().min(100).max(160),
  claims: z.array(z.string().trim().min(5)).max(20).default([])
});
export type Article = z.infer<typeof ArticleSchema>;
export function htmlEscape(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
export function safeSlug(value: string) { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0,120); }
