import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  ArticleSchema,
  normalizeTitle,
  normaliseArticlePayload,
  readingMinutes,
} from "../src/lib/article";
import { findPlaceMentions } from "../src/lib/places";
import { checkQuality, contentSimilarity, type QualityContext } from "../src/lib/quality";
import { isTrustedCitation } from "../src/lib/sources";

const APPROVED: QualityContext["approvedSources"] = [
  {
    sourceName: "Gatwick Airport (official)",
    sourceUrl: "https://www.gatwickairport.com/",
    notes:
      "Authoritative for Gatwick terminals, North and South Terminal layout, the inter-terminal shuttle, and official guidance on arrivals and departures.",
  },
  {
    sourceName: "National Rail Enquiries",
    sourceUrl: "https://www.nationalrail.co.uk/",
    notes:
      "Authoritative for which stations exist, station facilities, timetable and engineering-work information across the Great Britain rail network.",
  },
];

function paragraph(seed: string, sentences: number) {
  return Array.from(
    { length: sentences },
    (_, i) =>
      `${seed} Planning ahead makes the difference between a calm departure and a scramble, particularly when you are travelling with other people who are relying on you to get the timing right, point ${i + 1}.`,
  ).join(" ");
}

function baseArticle(overrides: Record<string, unknown> = {}) {
  const content = [
    paragraph("Travelling out of Brighton towards the airport rewards a little preparation.", 5),
    paragraph("Think about which part of the journey is least predictable.", 5),
    paragraph("Luggage changes the calculation more than most people expect.", 5),
    paragraph("Finally, write down the details you will need when you are tired.", 5),
  ].join("\n\n");

  return ArticleSchema.parse({
    title: "Planning a calmer airport run out of Brighton",
    slug: "planning-a-calmer-airport-run-out-of-brighton",
    excerpt:
      "How to build a sensible margin into an early airport journey, and the handful of things worth checking the night before you travel.",
    content,
    metaDescription:
      "Practical guidance on planning an early airport journey from Brighton, including what to check the night before and how much margin to allow yourself.",
    claims: [],
    sources: [],
    tags: ["airport", "planning"],
    ...overrides,
  });
}

function context(overrides: Partial<QualityContext> = {}): QualityContext {
  return {
    locationName: "Brighton",
    existingTitles: [],
    existingSlugs: [],
    existingContents: [],
    approvedSources: APPROVED,
    ...overrides,
  };
}

describe("checkQuality", () => {
  test("a clean article with no material claims passes", () => {
    const result = checkQuality(baseArticle(), context());

    assert.deepEqual(result.reasons, [], `unexpected reasons: ${result.reasons}`);
    assert.equal(result.pass, true);
    assert.ok(result.score >= 85);
  });

  test("blocks a duplicate title regardless of punctuation and case", () => {
    const article = baseArticle();

    const result = checkQuality(
      article,
      context({
        existingTitles: ["Planning a CALMER airport run, out of Brighton!"],
      }),
    );

    assert.ok(result.reasons.includes("duplicate_title"));
    assert.equal(result.pass, false);
  });

  test("blocks a duplicate slug", () => {
    const article = baseArticle();

    const result = checkQuality(
      article,
      context({ existingSlugs: [article.slug] }),
    );

    assert.ok(result.reasons.includes("duplicate_slug"));
  });

  test("blocks a near-duplicate body even when the title differs", () => {
    const article = baseArticle();

    const result = checkQuality(
      baseArticle({
        title: "A completely different headline about airport timing",
        slug: "a-completely-different-headline-about-airport-timing",
      }),
      context({
        existingContents: [{ slug: "older-article", content: article.content }],
      }),
    );

    assert.ok(result.reasons.includes("duplicate_content"));
  });

  test("blocks placeholder residue", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nTODO: add the fare table here.`,
      }),
      context(),
    );

    assert.ok(result.reasons.includes("placeholder_text"));
  });

  test("blocks model self-reference", () => {
    const result = checkQuality(
      baseArticle({
        content: `As an AI language model I cannot confirm current timetables.\n\n${baseArticle().content}`,
      }),
      context(),
    );

    assert.ok(result.reasons.includes("placeholder_text"));
  });

  test("blocks promotional overreach", () => {
    for (const phrase of [
      "We are the cheapest taxi in town.",
      "Your arrival is a guaranteed fixed fare.",
      "Our drivers are never late.",
      "One customer said it was excellent.",
      "We are award-winning.",
    ]) {
      const result = checkQuality(
        baseArticle({ content: `${phrase}\n\n${baseArticle().content}` }),
        context(),
      );

      assert.ok(
        result.reasons.includes("unsupported_promotional_claim"),
        `expected "${phrase}" to be blocked`,
      );
    }
  });

  test("blocks a material claim with no approved backing", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nThe fare to the airport is £45 at any time of day.`,
        claims: [{ text: "The fare to the airport is £45 at any time of day." }],
      }),
      context(),
    );

    assert.ok(result.reasons.includes("unverified_material_claim"));
    assert.equal(result.details.unverifiedClaims.length, 1);
  });

  test("accepts a material claim that names an approved source url", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nGatwick Airport has a North Terminal and a South Terminal.`,
        claims: [
          {
            text: "Gatwick Airport has a North Terminal and a South Terminal, connected by a shuttle.",
            sourceUrl: "https://www.gatwickairport.com/",
          },
        ],
        sources: ["https://www.gatwickairport.com/"],
      }),
      context(),
    );

    assert.ok(
      !result.reasons.includes("unverified_material_claim"),
      `unexpected reasons: ${result.reasons}`,
    );
  });

  test("blocks material claims in the body when none were declared", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nTrains run every 15 minutes throughout the day and the fare is £12.`,
        claims: [],
      }),
      context(),
    );

    assert.ok(result.reasons.includes("undeclared_material_claim"));
  });

  test("does not treat ordinary advice mentioning licensing as a claim", () => {
    // Regression: matching a bare "licensed" made these three sentences count
    // as material claims, which held a correct article for review.
    const advice = [
      "If you book private hire, confirm that the operator is licensed and ask about the likely cost before the journey begins.",
      "Booking through a licensed operator means you have a record of the journey and a regulated driver.",
      "By checking station details, campus guidance and licensing rules ahead of time, you can choose the best option.",
    ].join(" ");

    const result = checkQuality(
      baseArticle({ content: `${baseArticle().content}

${advice}` }),
      context(),
    );

    assert.ok(
      !result.reasons.includes("undeclared_material_claim"),
      `unexpected reasons: ${result.reasons}; undeclared: ${JSON.stringify(result.details.undeclaredMaterialSentences)}`,
    );
  });

  test("still requires an assertive licensing claim to be declared", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}

All drivers are licensed by the local council and every vehicle is wheelchair accessible.`,
        claims: [],
      }),
      context(),
    );

    assert.ok(result.reasons.includes("undeclared_material_claim"));
    assert.ok(result.details.undeclaredMaterialSentences.length > 0);
  });

  test("blocks an invented station", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nYou can also start from Brighton Central Parkway Station if that is closer.`,
      }),
      context(),
    );

    assert.ok(result.reasons.includes("unrecognised_transport_place"));
    assert.ok(result.details.unrecognisedPlaces.length > 0);
  });

  test("accepts real stations and airports", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nHaywards Heath Station and Three Bridges Station both connect towards Gatwick Airport, and London Victoria Station is the other direction.`,
      }),
      context(),
    );

    assert.ok(
      !result.reasons.includes("unrecognised_transport_place"),
      `unexpected places: ${result.details.unrecognisedPlaces}`,
    );
  });

  test("blocks an untrusted citation in the body", () => {
    const result = checkQuality(
      baseArticle({
        content: `${baseArticle().content}\n\nSee https://random-fare-blog.example.com/brighton for a fare table.`,
      }),
      context(),
    );

    assert.ok(result.reasons.includes("untrusted_citation"));
  });

  test("blocks an article that never mentions its location", () => {
    const result = checkQuality(
      baseArticle({
        content: baseArticle().content.replaceAll("Brighton", "Manchester"),
      }),
      context(),
    );

    assert.ok(result.reasons.includes("location_not_referenced"));
  });

  test("blocks keyword stuffing of the location name", () => {
    const stuffed = `${"Brighton taxi Brighton airport Brighton station Brighton travel. ".repeat(40)}`;

    const result = checkQuality(
      baseArticle({ content: `${stuffed}\n\n${stuffed}\n\n${stuffed}\n\n${stuffed}` }),
      context(),
    );

    assert.ok(result.reasons.includes("keyword_stuffing"));
  });

  test("blocks html in the body", () => {
    const result = checkQuality(
      baseArticle({
        content: `<p>${baseArticle().content}</p>`,
      }),
      context(),
    );

    assert.ok(result.reasons.includes("html_in_content"));
  });

  test("blocks a body that is too short", () => {
    const short = [
      "Brighton is a good place to start a journey.",
      "Allow a little more time than you think you need.",
      "Check the route the night before you travel.",
      "Write down the details you will want when you are tired.",
    ].join("\n\n");

    const result = checkQuality(
      baseArticle({ content: short.padEnd(1250, " and plan ahead.") }),
      context(),
    );

    assert.ok(result.reasons.includes("content_too_short"));
  });

  test("blocks an excerpt that merely restates the title", () => {
    const result = checkQuality(
      baseArticle({
        excerpt: "Planning a calmer airport run out of Brighton!!!!!!!!!!!!!!!!!!!",
      }),
      context(),
    );

    assert.ok(result.reasons.includes("excerpt_duplicates_title"));
  });

  test("a failing article can never score high enough to pass", () => {
    const result = checkQuality(
      baseArticle({ content: `${baseArticle().content}\n\nTODO finish this.` }),
      context(),
    );

    assert.equal(result.pass, false);
    assert.ok(result.score < 85);
  });
});

describe("contentSimilarity", () => {
  test("identical text is 1", () => {
    const text = "the quick brown fox jumps over the lazy dog again and again";
    assert.equal(contentSimilarity(text, text), 1);
  });

  test("unrelated text is near 0", () => {
    assert.ok(
      contentSimilarity(
        "planning an airport journey from brighton in good time",
        "completely unrelated subject matter about baking sourdough bread",
      ) < 0.1,
    );
  });

  test("text shorter than one trigram is 0 rather than a crash", () => {
    assert.equal(contentSimilarity("two words", "two words"), 0);
  });
});

describe("findPlaceMentions", () => {
  test("recognises a real station named in prose", () => {
    const found = findPlaceMentions("Travel from Haywards Heath Station first.");
    assert.equal(found.length, 1);
    assert.equal(found[0].recognised, true);
    assert.equal(found[0].kind, "station");
  });

  test("flags an invented airport", () => {
    const found = findPlaceMentions("Fly from Lewes International Airport.");
    assert.equal(found.length, 1);
    assert.equal(found[0].recognised, false);
    assert.equal(found[0].kind, "airport");
  });

  test("strips leading noise words from the name", () => {
    const found = findPlaceMentions("Head to the nearest Brighton Station.");
    assert.equal(found[0].recognised, true);
  });

  test("handles Gatwick Airport Station, which is both", () => {
    const found = findPlaceMentions("Change at Gatwick Airport Station.");
    assert.ok(found.every((place) => place.recognised));
  });
});

describe("isTrustedCitation", () => {
  test("accepts approved and official domains", () => {
    for (const url of [
      "https://www.gatwickairport.com/to-and-from",
      "https://www.gov.uk/taxi-driver-licence",
      "https://www.brighton-hove.gov.uk/parking-and-travel",
      "https://www.sussex.ac.uk/about",
      "https://www.nationalrail.co.uk/stations",
    ]) {
      assert.ok(isTrustedCitation(url), `expected ${url} to be trusted`);
    }
  });

  test("rejects anything else, including lookalikes", () => {
    for (const url of [
      "https://gatwickairport.com.evil.example/",
      "https://random-fare-blog.example.com/",
      "http://localhost:3000/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      assert.ok(!isTrustedCitation(url), `expected ${url} to be rejected`);
    }
  });
});

describe("normalizeTitle", () => {
  test("matches the posts.title_normalized SQL expression", () => {
    // SQL: btrim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))
    assert.equal(
      normalizeTitle("  Brighton to Gatwick: What's Worth Checking?  "),
      "brighton to gatwick what s worth checking",
    );
    assert.equal(normalizeTitle("A--B__C"), "a b c");
  });
});

describe("readingMinutes", () => {
  test("never returns zero", () => {
    assert.equal(readingMinutes("one"), 1);
  });

  test("rounds up at 220 words per minute", () => {
    assert.equal(readingMinutes("word ".repeat(221)), 2);
  });
});

describe("normaliseArticlePayload", () => {
  const metaOf = (payload: unknown) =>
    (payload as { metaDescription: string }).metaDescription;

  test("leaves a meta description within the limit untouched", () => {
    const meta = "a".repeat(160);
    const result = normaliseArticlePayload({ metaDescription: meta });

    assert.equal(metaOf(result), meta);
  });

  test("trims an overrunning meta description at a word boundary", () => {
    const meta = `${"word ".repeat(40)}overflowing tail`;
    const result = normaliseArticlePayload({ metaDescription: meta });
    const trimmed = metaOf(result);

    assert.ok(trimmed.length <= 160);
    assert.ok(trimmed.length >= 100);
    assert.ok(!trimmed.endsWith(" "));
    assert.ok(meta.startsWith(trimmed));
  });

  test("a trimmed meta description still satisfies the schema", () => {
    const article = {
      title: "Getting to Gatwick Airport from East Grinstead by car",
      slug: "gatwick-from-east-grinstead",
      excerpt:
        "What the drive from East Grinstead to Gatwick Airport actually involves, from route choice to where you can drop passengers off.",
      content: "c".repeat(1300),
      metaDescription: `${"The drive from East Grinstead to Gatwick takes about half an hour. ".repeat(3)}and here is some more text that pushes it over the limit.`,
      claims: [],
      tags: [],
      sources: [],
    };

    const parsed = ArticleSchema.parse(normaliseArticlePayload(article));

    assert.ok(parsed.metaDescription.length <= 160);
    assert.ok(parsed.metaDescription.length >= 100);
  });

  test("passes through values it cannot normalise", () => {
    assert.equal(normaliseArticlePayload(null), null);
    assert.equal(normaliseArticlePayload("not an object"), "not an object");
    assert.deepEqual(normaliseArticlePayload({ metaDescription: 7 }), {
      metaDescription: 7,
    });
  });
});
