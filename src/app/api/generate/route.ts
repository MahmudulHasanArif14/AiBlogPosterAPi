import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ArticleSchema } from "@/lib/article";
import { checkQuality } from "@/lib/quality";
import { supabaseAdmin } from "@/lib/supabase";
import { findWikimediaImage } from "@/lib/images/wikimedia";
export const runtime = "nodejs";
const RequestSchema = z.object({
  locationSlug: z.string().min(2).max(80),
  topic: z.string().min(5).max(240),
  jobId: z.string().uuid().optional(),
});
function cronAuthorized(req: NextRequest) {
  const s = process.env.CRON_SECRET;
  return !!s && req.headers.get("authorization") === `Bearer ${s}`;
}
export async function POST(req: NextRequest) {
  if (!cronAuthorized(req))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = RequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const supabase = supabaseAdmin();
  const input = parsed.data;
  const { data: loc, error: locErr } = await supabase
    .from("locations")
    .select("id,name,slug,enabled")
    .eq("slug", input.locationSlug)
    .single();
  if (locErr || !loc || !loc.enabled)
    return NextResponse.json(
      { error: "Location not found or disabled" },
      { status: 404 },
    );
  const { data: sourceRows } = await supabase
    .from("content_sources")
    .select("notes,source_name")
    .eq("approved", true);
  const facts = (sourceRows || [])
    .map((x) => `${x.source_name}: ${x.notes || ""}`)
    .filter(Boolean);
  const { data: oldPosts } = await supabase
    .from("posts")
    .select("title")
    .eq("location_id", loc.id)
    .limit(200);
  const model = process.env.OPENROUTER_MODEL;
  const key = process.env.OPENROUTER_API_KEY;
  if (!model || !key)
    return NextResponse.json(
      { error: "AI provider not configured" },
      { status: 503 },
    );
  let aiResponse: Response;
  try {
    aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          process.env.SITE_URL || "https://content.westerncars.co.uk",
        "X-Title": "Western Cars Content Hub",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        max_tokens: 4500,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You write accurate, useful UK travel information. Return JSON only with title, slug, excerpt, content, metaDescription, claims. Each claims entry must be a material factual claim made in the article. Use only the approved facts supplied. Never invent fares, company services, opening times, statistics, testimonials or legal claims. If facts are missing, avoid the claim. Write original, helpful prose, not doorway pages or keyword stuffing. Content must be plain text with paragraph breaks; do not include HTML.",
          },
          {
            role: "user",
            content: JSON.stringify({
              location: loc.name,
              topic: input.topic,
              approvedFacts: facts,
              requirements:
                "Write an evergreen article with practical planning advice. Do not claim a specific Western Cars service or fare unless an approved fact explicitly supports it.",
            }),
          },
        ],
      }),
      signal: AbortSignal.timeout(85000),
    });
  } catch {
    return NextResponse.json(
      { error: "Provider timeout; retry later" },
      { status: 503 },
    );
  }
  if (!aiResponse.ok)
    return NextResponse.json(
      {
        error:
          aiResponse.status === 429
            ? "Provider rate limit; retry later"
            : "Provider error; retry later",
        retryable: true,
      },
      { status: 503 },
    );
  const payload = await aiResponse.json().catch(() => null);
  const raw = payload?.choices?.[0]?.message?.content;
  let article;
  try {
    article = ArticleSchema.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json(
      { error: "Invalid article structure; retry or quarantine" },
      { status: 422 },
    );
  }

  const quality = checkQuality(
    article,
    (oldPosts || []).map((p) => p.title),
    facts,
  );

  // Search for a licence-checked featured image.
  const image = await findWikimediaImage(loc.name, input.topic);

  // A missing image is a publication blocker, not a generation blocker.
  const finalQuality = image
    ? quality
    : {
        ...quality,
        pass: false,
        score: Math.min(quality.score, 65),
        reasons: [...new Set([...quality.reasons, "image_not_verified"])],
      };

  const autoPublish =
    finalQuality.pass &&
    image !== null &&
    process.env.AUTO_PUBLISH_ENABLED === "true";

  const base = (
    process.env.SITE_URL || "https://content.westerncars.co.uk"
  ).replace(/\/$/, "");

  const postData = {
    location_id: loc.id,
    title: article.title,
    slug: article.slug,
    excerpt: article.excerpt,
    content: article.content,
    meta_description: article.metaDescription,

    status: autoPublish ? "published" : "needs_review",
    published_at: autoPublish ? new Date().toISOString() : null,
    canonical_url: autoPublish ? `${base}/posts/${article.slug}` : null,

    image_url: image?.image_url ?? null,
    image_alt: image?.image_alt ?? null,
    image_credit: image?.image_credit ?? null,
    image_source_url: image?.image_source_url ?? null,
    image_provider: image?.image_provider ?? null,
    image_mime: image?.image_mime ?? null,
    image_width: image?.image_width ?? null,
    image_height: image?.image_height ?? null,
    image_license: image?.image_license ?? null,
    image_license_url: image?.image_license_url ?? null,
  };

  const { data: post, error: saveErr } = await supabase
    .from("posts")
    .insert(postData)
    .select("id,title,slug,status,image_url,image_source_url,image_license")
    .single();

  if (saveErr) {
    console.error("Article save failed:", saveErr.message);

    return NextResponse.json(
      {
        error: "Save failed; check duplicate slug and database logs",
      },
      { status: 409 },
    );
  }

  if (input.jobId) {
    await supabase
      .from("generation_jobs")
      .update({
        status: "completed",
        error_message: finalQuality.pass
          ? null
          : `quality:${finalQuality.reasons.join(",")}`,
      })
      .eq("id", input.jobId);
  }

  await supabase.from("activity_log").insert({
    action:
      post.status === "published" ? "auto_published" : "generated_for_review",
    entity_type: "post",
    entity_id: post.id,
    details: {
      quality_score: finalQuality.score,
      quality_reasons: finalQuality.reasons,
      model,
      image_found: Boolean(image),
      image_provider: image?.image_provider ?? null,
      image_license: image?.image_license ?? null,
    },
  });

  return NextResponse.json(
    {
      post,
      quality: finalQuality,
      image: image
        ? {
            provider: image.image_provider,
            sourceUrl: image.image_source_url,
            license: image.image_license,
            licenseUrl: image.image_license_url,
          }
        : null,
    },
    { status: 201 },
  );
}
