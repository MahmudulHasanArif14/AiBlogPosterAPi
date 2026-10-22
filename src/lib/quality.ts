import {
  normalizeTitle,
  wordCount,
  type Article,
  type ArticleClaim,
} from "./article";
import { MIN_ARTICLE_QUALITY_SCORE } from "./config";
import { findPlaceMentions } from "./places";
import { isTrustedCitation } from "./sources";

// What this gate is and is not
// ----------------------------
// It decides whether an article is *eligible* for publication. It checks
// structure, duplication, placeholder residue, promotional overreach, citation
// provenance and local plausibility. It does not and cannot establish that a
// statement is true. A claim passes when it is traceable to an approved source,
// which is a provenance test, not a truth test. Anything it cannot place is
// routed to human review rather than published.

export type ApprovedSource = {
  sourceName: string;
  sourceUrl: string | null;
  notes: string;
};

export type QualityContext = {
  locationName: string;
  /** Normalised titles already in the database, any status. */
  existingTitles: string[];
  existingSlugs: string[];
  /** Published bodies for the same location, for near-duplicate detection. */
  existingContents: { slug: string; content: string }[];
  approvedSources: ApprovedSource[];
};

export type QualityResult = {
  pass: boolean;
  score: number;
  /** Blocking problems. A non-empty list means the article must not publish. */
  reasons: string[];
  /** Advisory notes that do not block publication. */
  warnings: string[];
  details: {
    words: number;
    maxContentSimilarity: number;
    mostSimilarSlug: string | null;
    unverifiedClaims: string[];
    verifiedClaims: { text: string; sourceName: string }[];
    unrecognisedPlaces: string[];
    untrustedCitations: string[];
    /** Material sentences no declared claim covers, which is why a hold
        for undeclared_material_claim can be acted on without guessing. */
    undeclaredMaterialSentences: string[];
  };
};

const MIN_WORDS = 450;
const MAX_WORDS = 2600;
const CONTENT_DUPLICATE_THRESHOLD = 0.6;
const CONTENT_SIMILARITY_WARNING = 0.45;
const MAX_LOCATION_DENSITY = 0.025;

// Residue from a template or from the model talking about itself. Any of these
// in a body means the generation did not really finish.
const PLACEHOLDER_PATTERNS: [RegExp, string][] = [
  [/lorem ipsum/i, "lorem ipsum"],
  [/\b(?:TODO|TBD|FIXME|XXX)\b/, "todo marker"],
  [
    /\[(?:insert|your|add|location|topic|placeholder)[^\]]*\]/i,
    "square-bracket placeholder",
  ],
  [/\{\{[^}]*\}\}/, "template token"],
  [
    /\b(?:as an AI|as a language model|I cannot|I'm unable to|I am unable to)\b/i,
    "model self-reference",
  ],
  [
    /\bhere(?:'s| is) (?:the|your) (?:article|blog post|json)\b/i,
    "assistant preamble",
  ],
  [/\b(?:Lorem|Ipsum|Example Text|Sample text)\b/, "sample text"],
  [/\.{4,}/, "ellipsis filler"],
  [/\bN\/A\b/, "n/a placeholder"],
];

// Promotional claims an article is never allowed to make on the company's
// behalf, because none of them can be substantiated by a public source.
const PROMOTIONAL_PATTERNS: [RegExp, string][] = [
  [
    /\b(?:guaranteed|guarantee[sd]?) (?:fixed )?(?:fare|price|arrival|pickup|pick-up)\b/i,
    "guaranteed fare or arrival",
  ],
  [/\bcheapest (?:taxi|fare|ride|transfer)\b/i, "cheapest claim"],
  [
    /\b(?:best|number one|#1|leading|most reliable|most trusted) (?:taxi|cab|transfer|operator|service) (?:in|for|around)\b/i,
    "superlative market claim",
  ],
  [
    /\b100%\s*(?:reliable|guaranteed|on[- ]time|satisfaction)\b/i,
    "absolute reliability claim",
  ],
  [
    /\b(?:never late|always on time|always available)\b/i,
    "absolute availability claim",
  ],
  [
    /\b(?:customer|passenger|client) (?:said|told us|reported)\b/i,
    "unverifiable testimonial",
  ],
  [/\b(?:five|5)[- ]star review\b/i, "review claim"],
  [/\btestimonial\b/i, "testimonial"],
  [/\b(?:award[- ]winning|voted (?:the )?best)\b/i, "award claim"],
  [/\bno (?:hidden|extra) (?:fees|charges|costs)\b/i, "pricing guarantee"],
];

// Claim shapes that must be traceable to an approved source: money, clock
// times, durations, distances, statistics, capacities, and regulated
// credentials. These are where a generated article does real damage if wrong.
const MATERIAL_CLAIM_PATTERNS = [
  /£\s?\d/,
  /\b\d+(?:\.\d+)?\s*(?:p|pence|pounds?|GBP)\b/i,
  /\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b/i,
  /\b\d+\s*(?:–|-|to)?\s*\d*\s*(?:minute|minutes|min|mins|hour|hours|hr|hrs)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:mile|miles|km|kilometre|kilometres|metre|metres|m)\b/i,
  /\b\d+(?:\.\d+)?\s*(?:%|per cent|percent)/i,
  /\b\d+\s*(?:seater|seats|passengers|bags|suitcases)\b/i,
  /\b(?:24\/7|around the clock|all night)\b/i,
  // Regulated credentials, but only where the sentence actually asserts
  // something about them. A bare "a licensed operator" is ordinary travel
  // prose, not a checkable claim: matching `licen[sc]ed` on its own flagged
  // advice like "confirm that the operator is licensed" as a material claim
  // and held good articles for review.
  /\b(?:wheelchair[- ]accessible|wheelchair access|DBS|enhanced (?:DBS )?check)\b/i,
  /\b(?:licensing authority|licen[sc]ed by|must be licen[sc]ed|fully licen[sc]ed|licen[sc]e number)\b/i,
  /\bmust be pre-?booked\b/i,
  /\b(?:fixed[- ]price|fixed fare|meter(?:ed)? fare|flat rate)\b/i,
  /\b(?:every|each)\s+\d+\s*minutes?\b/i,
  /\b(?:opens?|closes?|open|closed)\s+(?:at|from|until)\b/i,
  /\bplatform\s+\d+\b/i,
];

function normaliseForCompare(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity over word trigrams. Catches reworded near-duplicates. */
export function contentSimilarity(a: string, b: string): number {
  const shingles = (value: string) => {
    const words = normaliseForCompare(value).split(" ").filter(Boolean);
    const set = new Set<string>();

    for (let i = 0; i + 2 < words.length; i += 1) {
      set.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }

    return set;
  };

  const left = shingles(a);
  const right = shingles(b);

  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;

  for (const shingle of left) {
    if (right.has(shingle)) {
      shared += 1;
    }
  }

  return shared / (left.size + right.size - shared);
}

function isMaterialClaim(text: string) {
  return MATERIAL_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Match a claim to an approved source. A claim is backed when it names the
 * source URL explicitly, or when enough of its distinctive words appear in an
 * approved source's notes for the source to plausibly cover it.
 */
function findBackingSource(
  claim: ArticleClaim,
  approvedSources: ApprovedSource[],
): ApprovedSource | null {
  if (claim.sourceUrl) {
    const direct = approvedSources.find(
      (source) =>
        source.sourceUrl &&
        (source.sourceUrl === claim.sourceUrl ||
          claim.sourceUrl!.startsWith(source.sourceUrl)),
    );

    if (direct) {
      return direct;
    }
  }

  const claimWords = new Set(
    normaliseForCompare(claim.text)
      .split(" ")
      .filter((word) => word.length > 3),
  );

  if (claimWords.size === 0) {
    return null;
  }

  let best: ApprovedSource | null = null;
  let bestOverlap = 0;

  for (const source of approvedSources) {
    const haystack = new Set(
      normaliseForCompare(`${source.sourceName} ${source.notes}`)
        .split(" ")
        .filter((word) => word.length > 3),
    );

    let overlap = 0;

    for (const word of claimWords) {
      if (haystack.has(word)) {
        overlap += 1;
      }
    }

    const ratio = overlap / claimWords.size;

    if (ratio > bestOverlap) {
      bestOverlap = ratio;
      best = source;
    }
  }

  // Half the claim's distinctive vocabulary has to be covered by the source
  // description before we treat the source as backing it.
  return bestOverlap >= 0.5 ? best : null;
}

function extractUrls(value: string) {
  return [...value.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)].map((match) =>
    match[0].replace(/[.,;:!?)]+$/, ""),
  );
}

export function checkQuality(
  article: Article,
  context: QualityContext,
): QualityResult {
  const reasons: string[] = [];
  const warnings: string[] = [];

  const words = wordCount(article.content);
  const title = normalizeTitle(article.title);

  // --- Structure -----------------------------------------------------------

  if (words < MIN_WORDS) {
    reasons.push("content_too_short");
  }

  if (words > MAX_WORDS) {
    warnings.push("content_longer_than_target");
  }

  const normalizedContent = article.content.replace(/\r\n?/g, "\n").trim();

  const paragraphs = normalizedContent
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 2) {
    warnings.push("limited_paragraph_structure");
  }

  if (/<\/?[a-z][\s\S]*>/i.test(article.content)) {
    reasons.push("html_in_content");
  }

  if (
    article.metaDescription.length < 70 ||
    article.metaDescription.length > 160
  ) {
    reasons.push("meta_description_length");
  }

  if (
    normaliseForCompare(article.excerpt) === normaliseForCompare(article.title)
  ) {
    reasons.push("excerpt_duplicates_title");
  }

  // --- Duplication ---------------------------------------------------------

  if (
    context.existingTitles.some(
      (existing) => normalizeTitle(existing) === title,
    )
  ) {
    reasons.push("duplicate_title");
  }

  if (context.existingSlugs.includes(article.slug)) {
    reasons.push("duplicate_slug");
  }

  let maxContentSimilarity = 0;
  let mostSimilarSlug: string | null = null;

  for (const existing of context.existingContents) {
    const similarity = contentSimilarity(article.content, existing.content);

    if (similarity > maxContentSimilarity) {
      maxContentSimilarity = similarity;
      mostSimilarSlug = existing.slug;
    }
  }

  if (maxContentSimilarity >= CONTENT_DUPLICATE_THRESHOLD) {
    reasons.push("duplicate_content");
  } else if (maxContentSimilarity >= CONTENT_SIMILARITY_WARNING) {
    warnings.push("content_similar_to_existing");
  }

  // --- Placeholder and promotional text ------------------------------------

  const haystack = `${article.title}\n${article.excerpt}\n${article.content}\n${article.metaDescription}`;

  for (const [pattern, label] of PLACEHOLDER_PATTERNS) {
    if (pattern.test(haystack)) {
      reasons.push("placeholder_text");
      warnings.push(`placeholder:${label}`);
      break;
    }
  }

  for (const [pattern, label] of PROMOTIONAL_PATTERNS) {
    if (pattern.test(haystack)) {
      reasons.push("unsupported_promotional_claim");
      warnings.push(`promotional:${label}`);
    }
  }

  // --- Citation provenance -------------------------------------------------

  const approvedHostnames = new Set<string>();

  for (const source of context.approvedSources) {
    if (!source.sourceUrl) {
      continue;
    }

    try {
      approvedHostnames.add(new URL(source.sourceUrl).hostname.toLowerCase());
    } catch {
      // Ignore a malformed stored URL rather than failing the whole gate.
    }
  }

  const untrustedCitations = [
    ...extractUrls(article.content),
    ...article.sources,
  ].filter((url) => !isTrustedCitation(url, approvedHostnames));

  if (untrustedCitations.length > 0) {
    reasons.push("untrusted_citation");
  }

  // --- Material claims ----------------------------------------------------

  const unverifiedClaims: string[] = [];
  const verifiedClaims: { text: string; sourceName: string }[] = [];

  for (const claim of article.claims) {
    if (!isMaterialClaim(claim.text)) {
      continue;
    }

    const backing = findBackingSource(claim, context.approvedSources);

    if (backing) {
      verifiedClaims.push({ text: claim.text, sourceName: backing.sourceName });
    } else {
      unverifiedClaims.push(claim.text);
    }
  }

  if (unverifiedClaims.length > 0) {
    reasons.push("unverified_material_claim");
  }

  // A material claim made in the body but never declared cannot be checked at
  // all, which is worse than one declared and rejected. Sentences are matched
  // to declared claims by vocabulary overlap, because a model paraphrases its
  // own claims rather than quoting them.
  const declaredVocabularies = article.claims.map(
    (claim) =>
      new Set(
        normaliseForCompare(claim.text)
          .split(" ")
          .filter((word) => word.length > 3),
      ),
  );

  const materialSentences = article.content
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && isMaterialClaim(sentence));

  const unmatchedMaterialSentences = materialSentences.filter((sentence) => {
    const sentenceWords = [
      ...new Set(
        normaliseForCompare(sentence)
          .split(" ")
          .filter((word) => word.length > 3),
      ),
    ];

    if (sentenceWords.length === 0) {
      return false;
    }

    return !declaredVocabularies.some((vocabulary) => {
      const overlap = sentenceWords.filter((word) =>
        vocabulary.has(word),
      ).length;
      return overlap / sentenceWords.length >= 0.5;
    });
  });

  if (unmatchedMaterialSentences.length > 0) {
    console.warn(
      "[quality] Unmatched material sentences:",
      JSON.stringify(unmatchedMaterialSentences, null, 2),
    );
    console.warn(
      "[quality] Declared claims:",
      JSON.stringify(
        article.claims.map((claim) => claim.text),
        null,
        2,
      ),
    );
  }

  if (materialSentences.length > 0 && article.claims.length === 0) {
    // The body makes checkable claims and the generator declared none, so
    // nothing about it can be traced. That is always blocking.
    reasons.push("undeclared_material_claim");
  } else if (
    materialSentences.length > 0 &&
    unmatchedMaterialSentences.length / materialSentences.length > 0.4
  ) {
    reasons.push("undeclared_material_claim");
  } else if (unmatchedMaterialSentences.length > 0) {
    warnings.push(
      `undeclared:${unmatchedMaterialSentences.length} sentence(s)`,
    );
  }

  if (article.claims.length === 0) {
    warnings.push("no_claims_declared");
  }

  if (article.sources.length === 0) {
    warnings.push("no_sources_declared");
  }

  // --- Local accuracy -----------------------------------------------------

  const places = findPlaceMentions(article.content);
  const unrecognisedPlaces = places
    .filter((place) => !place.recognised)
    .map((place) => `${place.name} (${place.kind})`);

  if (unrecognisedPlaces.length > 0) {
    reasons.push("unrecognised_transport_place");
  }

  const locationNeedle = normaliseForCompare(context.locationName);
  const normalisedContent = normaliseForCompare(article.content);

  if (locationNeedle && !normalisedContent.includes(locationNeedle)) {
    reasons.push("location_not_referenced");
  }

  if (locationNeedle && words > 0) {
    const occurrences = normalisedContent.split(locationNeedle).length - 1;

    if (occurrences / words > MAX_LOCATION_DENSITY) {
      reasons.push("keyword_stuffing");
    }
  }

  // --- Score ---------------------------------------------------------------

  const uniqueReasons = [...new Set(reasons)];
  const uniqueWarnings = [...new Set(warnings)];

  const score = Math.max(
    0,
    100 - uniqueReasons.length * 35 - uniqueWarnings.length * 3,
  );

  return {
    pass: uniqueReasons.length === 0 && score >= MIN_ARTICLE_QUALITY_SCORE,
    score,
    reasons: uniqueReasons,
    warnings: uniqueWarnings,
    details: {
      words,
      maxContentSimilarity: Number(maxContentSimilarity.toFixed(4)),
      mostSimilarSlug,
      unverifiedClaims,
      verifiedClaims,
      unrecognisedPlaces,
      untrustedCitations,
      undeclaredMaterialSentences: unmatchedMaterialSentences,
    },
  };
}
