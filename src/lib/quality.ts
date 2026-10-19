import type { Article } from "./article";

export type QualityResult = {
  pass: boolean;
  score: number;
  reasons: string[];
};

const forbidden = [
  /\b(guaranteed fixed fare|cheapest taxi in|100% reliable)\b/i,
  /\b(customer said|five-star review|testimonial)\b/i,
];

export function checkQuality(
  article: Article,
  existingTitles: string[],
  approvedFacts: string[],
): QualityResult {
  const reasons: string[] = [];

  const normalizeTitle = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, "")
      .trim();

  const title = normalizeTitle(article.title);

  if (
    existingTitles.some(
      (existingTitle) => normalizeTitle(existingTitle) === title,
    )
  ) {
    reasons.push("duplicate_title");
  }

  if (
    forbidden.some(
      (pattern) => pattern.test(article.content) || pattern.test(article.title),
    )
  ) {
    reasons.push("unsupported_superlative_or_testimonial");
  }

  // Company-specific claims must match an approved fact record.
  const risky =
    /£\s?\d|\b(24\/7|wheelchair|licensed|licenced|DBS|fixed price|fixed-price|executive cars|8-seater|eight-seater|airport pickup|airport drop-off)\b/i;

  for (const claim of article.claims ?? []) {
    const normalizedClaim = claim.trim().toLowerCase();

    if (
      risky.test(claim) &&
      !approvedFacts.some((fact) =>
        fact.toLowerCase().includes(normalizedClaim),
      )
    ) {
      reasons.push("unverified_company_claim");
    }
  }

  // Check paragraph structure using a valid newline escape.
  if (article.content.length > 2500 && !article.content.includes("\n")) {
    reasons.push("content_needs_paragraph_structure");
  }

  const uniqueReasons = [...new Set(reasons)];
  const score = Math.max(0, 100 - uniqueReasons.length * 35);

  return {
    pass: uniqueReasons.length === 0 && score >= 85,
    score,
    reasons: uniqueReasons,
  };
}
