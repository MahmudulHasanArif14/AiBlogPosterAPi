const PEXELS_API_URL = "https://api.pexels.com/v1/search";
const PEXELS_LICENSE_URL = "https://www.pexels.com/license/";
const MAX_QUERIES = 2;
const REQUEST_TIMEOUT_MS = 6000;

type PexelsPhoto = {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  src: {
    original?: string;
    large2x?: string;
    large?: string;
    landscape?: string;
  };
};

type PexelsResponse = {
  photos?: PexelsPhoto[];
};

export type FeaturedImage = {
  image_url: string;
  image_alt: string;
  image_credit: string;
  image_source_url: string;
  image_provider: string;
  image_mime: string;
  image_width: number;
  image_height: number;
  image_license: string;
  image_license_url: string;
};

function cleanQuery(value: string): string {
  return value
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildQueries(location: string, topic: string): string[] {
  const cleanLocation = cleanQuery(location);
  const cleanTopic = cleanQuery(topic);

  const candidates = [
    `${cleanTopic} ${cleanLocation}`,
    `${cleanTopic} ${cleanLocation} travel`,
    `${cleanLocation} UK`,
    cleanTopic,
    `${cleanLocation} landscape`,
  ];

  // Capped: each query is a separate network round trip, and the caller has a
  // 60-second budget to share with generation and source verification.
  return [
    ...new Set(candidates.map(cleanQuery).filter((query) => query.length > 0)),
  ].slice(0, MAX_QUERIES);
}

function isValidPexelsImageUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname === "images.pexels.com" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith("/photos/")
    );
  } catch {
    return false;
  }
}

function isValidPexelsPhoto(photo: PexelsPhoto): boolean {
  return (
    Number.isFinite(photo.id) &&
    photo.id > 0 &&
    Number.isFinite(photo.width) &&
    Number.isFinite(photo.height) &&
    photo.width >= 1200 &&
    photo.height >= 630 &&
    photo.width / photo.height >= 1.2 &&
    photo.width / photo.height <= 2.2 &&
    typeof photo.photographer === "string" &&
    photo.photographer.trim().length > 0 &&
    typeof photo.url === "string" &&
    /^https:\/\/www\.pexels\.com\/photo\/[a-z0-9-]+\/?$/i.test(photo.url)
  );
}

export async function findWikimediaImage(
  location: string,
  topic: string,
): Promise<FeaturedImage | null> {
  // Keep this name to preserve existing imports in route.ts.
  const apiKey = process.env.PEXELS_API_KEY?.trim();

  if (!apiKey) {
    console.error("PEXELS_API_KEY is not configured.");
    return null;
  }

  const queries = buildQueries(location, topic);

  if (queries.length === 0) {
    console.warn("No usable Pexels search query was generated.");
    return null;
  }

  for (const query of queries) {
    const url = new URL(PEXELS_API_URL);

    url.search = new URLSearchParams({
      query,
      orientation: "landscape",
      size: "large",
      per_page: "15",
    }).toString();

    let response: Response;

    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: apiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        next: { revalidate: 86400 },
      });
    } catch (error) {
      console.error(
        "Pexels request failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      return null;
    }

    if (!response.ok) {
      console.error(
        "Pexels photo search failed:",
        response.status,
        "Query:",
        query,
      );

      // Do not continue blindly after authentication, rate-limit,
      // or other API errors.
      return null;
    }

    let payload: PexelsResponse;

    try {
      payload = (await response.json()) as PexelsResponse;
    } catch {
      console.error("Pexels returned invalid JSON.");
      return null;
    }

    const photos = Array.isArray(payload.photos) ? payload.photos : [];

    for (const photo of photos) {
      if (!isValidPexelsPhoto(photo)) {
        continue;
      }

      const candidates = [
        photo.src.landscape,
        photo.src.large2x,
        photo.src.large,
        photo.src.original,
      ];

      const imageUrl = candidates.find(
        (candidate): candidate is string =>
          typeof candidate === "string" && isValidPexelsImageUrl(candidate),
      );

      if (!imageUrl) {
        continue;
      }

      return {
        image_url: imageUrl,
        image_alt: `${location}: ${topic} — photo by ${photo.photographer}`,
        image_credit: `Photo by ${photo.photographer} on Pexels`,
        image_source_url: photo.url,
        image_provider: "Pexels",
        image_mime: "image/jpeg",
        image_width: photo.width,
        image_height: photo.height,
        image_license: "Pexels License",
        image_license_url: PEXELS_LICENSE_URL,
      };
    }

    console.warn("No suitable Pexels photos for query:", query);
  }

  console.warn("Pexels returned no suitable image for the topic and location.");

  return null;
}
