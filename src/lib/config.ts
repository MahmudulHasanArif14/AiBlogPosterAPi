// Shared configuration. Deliberately free of any Next.js import, so the
// scheduled worker in scripts/ can use it outside a Next runtime.

// The platform's own timezone. Everything that means "a day" — the single daily
// generation slot, rotation fairness, article date display — resolves through
// this, never through the server's local time or UTC.
export const PLATFORM_TIMEZONE = "Europe/London";

export const PLATFORM_LOCALE = "en-GB";

export const POSTS_CACHE_TAG = "posts";
export const LOCATIONS_CACHE_TAG = "locations";

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 50;

export function siteUrl() {
  return (process.env.SITE_URL || "https://content.westerncars.com").replace(
    /\/$/,
    "",
  );
}

// How long to wait for the article-generation request.
//
// Measured against the configured reasoning model: a full article costs roughly
// 6000 reasoning tokens plus 1300 content tokens and takes 60-115 seconds. That
// does not fit Vercel's Hobby 60-second function limit, which is why the daily
// run is a GitHub Actions worker and the in-request endpoints are a fallback
// for short jobs only.
export const AI_REQUEST_TIMEOUT_MS = Number(
  process.env.AI_REQUEST_TIMEOUT_MS ?? 45_000,
);
