import { unstable_cache } from "next/cache";
import { LOCATIONS_CACHE_TAG, POSTS_CACHE_TAG, siteUrl } from "./config";
import { supabaseAdmin } from "./supabase";

// Re-exported so existing importers keep working; defined in config.ts, which
// has no Next.js dependency and is therefore usable by the scheduled worker.
export {
  POSTS_CACHE_TAG,
  LOCATIONS_CACHE_TAG,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  siteUrl,
} from "./config";

// Columns the public API is allowed to read. Deliberately excludes
// review_notes, verified_claims, quality_reasons, quality_score, content_hash
// and job_id: those are internal review and provenance records, and the brief
// is explicit that public callers must not reach them.
const PUBLIC_COLUMNS = [
  "id",
  "title",
  "slug",
  "excerpt",
  "meta_description",
  "canonical_url",
  "published_at",
  "updated_at",
  "location_id",
  "author",
  "category",
  "tags",
  "reading_minutes",
  "source_urls",
  "image_url",
  "image_alt",
  "image_credit",
  "image_source_url",
  "image_provider",
  "image_mime",
  "image_width",
  "image_height",
  "image_license",
  "image_license_url",
] as const;

type PostRow = Record<string, unknown> & {
  slug: string;
  location_id: string;
  title: string;
};

export type LocationSummary = { id: string; slug: string; name: string };

/**
 * Exactly what the public API returns for one article. Consuming websites code
 * against this shape, so every field here is a commitment.
 */
export type PublicPost = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  meta_description: string;
  canonical_url: string;
  url: string;
  content_url: string;
  published_at: string | null;
  updated_at: string | null;
  location_id: string;
  location: { slug: string; name: string } | null;
  author: string | null;
  category: string | null;
  tags: string[];
  reading_minutes: number | null;
  sources: string[];
  image_url: string | null;
  image_alt: string | null;
  image_credit: string | null;
  image_source_url: string | null;
  image_provider: string | null;
  image_mime: string | null;
  image_width: number | null;
  image_height: number | null;
  image_license: string | null;
  image_license_url: string | null;
  /** Present only when the caller asked for full content. */
  content?: string | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function serializePost(
  row: PostRow,
  locations: Map<string, LocationSummary>,
  options: { includeContent: boolean },
): PublicPost {
  const base = siteUrl();
  const location = locations.get(row.location_id);

  // The canonical URL on the central hub. Consuming websites set their own
  // canonical to their own domain; this field tells them where the article
  // lives centrally.
  const canonical = asString(row.canonical_url) ?? `${base}/posts/${row.slug}`;

  const post: PublicPost = {
    id: String(row.id),
    title: row.title,
    slug: row.slug,
    excerpt: asString(row.excerpt) ?? "",
    meta_description: asString(row.meta_description) ?? "",
    canonical_url: canonical,
    url: canonical,
    content_url: `${base}/api/posts/${row.slug}`,
    published_at: asString(row.published_at),
    updated_at: asString(row.updated_at),
    location_id: row.location_id,
    location: location ? { slug: location.slug, name: location.name } : null,
    author: asString(row.author),
    category: asString(row.category),
    tags: asStringArray(row.tags),
    reading_minutes: asNumber(row.reading_minutes),
    sources: asStringArray(row.source_urls),
    image_url: asString(row.image_url),
    image_alt: asString(row.image_alt),
    image_credit: asString(row.image_credit),
    image_source_url: asString(row.image_source_url),
    image_provider: asString(row.image_provider),
    image_mime: asString(row.image_mime),
    image_width: asNumber(row.image_width),
    image_height: asNumber(row.image_height),
    image_license: asString(row.image_license),
    image_license_url: asString(row.image_license_url),
  };

  if (options.includeContent) {
    post.content = asString(row.content);
  }

  return post;
}

async function loadLocationMap(): Promise<Map<string, LocationSummary>> {
  const db = supabaseAdmin();

  const { data, error } = await db.from("locations").select("id,slug,name");

  if (error) {
    throw new Error(`locations_lookup_failed: ${error.message}`);
  }

  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      { id: row.id as string, slug: row.slug as string, name: row.name as string },
    ]),
  );
}

/** Enabled locations, with how many published articles each one has. */
export const listLocations = unstable_cache(
  async () => {
    const db = supabaseAdmin();

    const { data: locations, error } = await db
      .from("locations")
      .select("id,slug,name,enabled,last_published_at")
      .eq("enabled", true)
      .order("rotation_order", { ascending: true })
      .order("slug", { ascending: true });

    if (error) {
      throw new Error(`locations_lookup_failed: ${error.message}`);
    }

    const { data: published, error: countError } = await db
      .from("posts")
      .select("location_id")
      .eq("status", "published");

    if (countError) {
      throw new Error(`published_count_failed: ${countError.message}`);
    }

    const counts = new Map<string, number>();

    for (const row of published ?? []) {
      const key = row.location_id as string;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return (locations ?? []).map((row) => ({
      slug: row.slug as string,
      name: row.name as string,
      published_posts: counts.get(row.id as string) ?? 0,
      last_published_at: (row.last_published_at as string | null) ?? null,
    }));
  },
  ["western-cars-locations"],
  { revalidate: 300, tags: [LOCATIONS_CACHE_TAG, POSTS_CACHE_TAG] },
);

export type ListResult = {
  posts: PublicPost[];
  total: number;
  location: { slug: string; name: string } | null;
};

async function queryPublishedPosts(
  locationSlug: string | null,
  page: number,
  limit: number,
  includeContent: boolean,
): Promise<ListResult | { notFound: true }> {
  const db = supabaseAdmin();
  const locations = await loadLocationMap();

  let locationId: string | null = null;
  let location: { slug: string; name: string } | null = null;

  if (locationSlug) {
    const { data: row, error } = await db
      .from("locations")
      .select("id,slug,name,enabled")
      .eq("slug", locationSlug)
      .maybeSingle();

    if (error) {
      throw new Error(`location_lookup_failed: ${error.message}`);
    }

    if (!row || !row.enabled) {
      return { notFound: true };
    }

    locationId = row.id as string;
    location = { slug: row.slug as string, name: row.name as string };
  }

  const columns = includeContent
    ? [...PUBLIC_COLUMNS, "content"]
    : [...PUBLIC_COLUMNS];

  let query = db
    .from("posts")
    .select(columns.join(","), { count: "exact" })
    .eq("status", "published")
    // id is the tie-breaker, so two articles published in the same instant
    // never swap places between pages.
    .order("published_at", { ascending: false })
    .order("id", { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (locationId) {
    query = query.eq("location_id", locationId);
  }

  const { data, error, count } = await query;

  if (error) {
    throw new Error(`posts_query_failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as PostRow[];

  return {
    posts: rows.map((row) => serializePost(row, locations, { includeContent })),
    total: count ?? 0,
    location,
  };
}

export function listPublishedPosts(
  locationSlug: string | null,
  page: number,
  limit: number,
  includeContent: boolean,
) {
  // Cache key has to carry every parameter, or one location's page would be
  // served for another's.
  const cached = unstable_cache(
    () => queryPublishedPosts(locationSlug, page, limit, includeContent),
    [
      "western-cars-posts",
      locationSlug ?? "all",
      String(page),
      String(limit),
      includeContent ? "full" : "summary",
    ],
    { revalidate: 300, tags: [POSTS_CACHE_TAG] },
  );

  return cached();
}

async function queryPublishedPost(slug: string) {
  const db = supabaseAdmin();

  const { data, error } = await db
    .from("posts")
    .select([...PUBLIC_COLUMNS, "content"].join(","))
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    throw new Error(`post_query_failed: ${error.message}`);
  }

  if (!data) {
    return null;
  }

  const locations = await loadLocationMap();

  return serializePost(data as unknown as PostRow, locations, {
    includeContent: true,
  });
}

export function getPublishedPost(slug: string) {
  const cached = unstable_cache(
    () => queryPublishedPost(slug),
    ["western-cars-post", slug],
    { revalidate: 300, tags: [POSTS_CACHE_TAG] },
  );

  return cached();
}
