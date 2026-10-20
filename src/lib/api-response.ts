import { NextResponse } from "next/server";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./config";

// Published content is public and immutable enough to cache hard at the edge.
// New articles appear within s-maxage; revalidateTag clears the data cache
// immediately on publish, so the worst case is one stale minute at the CDN.
export const PUBLISHED_CACHE_CONTROL =
  "public, s-maxage=60, stale-while-revalidate=300";

export const ERROR_CACHE_CONTROL = "no-store";

export type ApiErrorCode =
  | "invalid_location"
  | "unknown_location"
  | "invalid_page"
  | "invalid_limit"
  | "invalid_content_mode"
  | "post_not_found"
  | "server_error";

/**
 * Error body keeps `error` as a plain human-readable string, which is what the
 * currently deployed endpoint returns, and adds a stable machine-readable
 * `code` beside it. Existing clients are unaffected.
 */
export function apiError(
  code: ApiErrorCode,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  return NextResponse.json(
    { error: message, code, ...(details ? { details } : {}) },
    { status, headers: { "Cache-Control": ERROR_CACHE_CONTROL } },
  );
}

const LOCATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type ParsedQuery = {
  location: string | null;
  page: number;
  limit: number;
  includeContent: boolean;
};

export function parseListQuery(
  params: URLSearchParams,
): { ok: true; value: ParsedQuery } | { ok: false; response: NextResponse } {
  const rawLocation = params.get("location");
  const rawPage = params.get("page");
  const rawLimit = params.get("limit");
  const rawContent = params.get("content");

  let location: string | null = null;

  if (rawLocation !== null && rawLocation.trim() !== "") {
    const candidate = rawLocation.trim().toLowerCase();

    if (candidate.length > 80 || !LOCATION_SLUG.test(candidate)) {
      return {
        ok: false,
        response: apiError(
          "invalid_location",
          "The location parameter must be a lowercase hyphenated slug, for example 'brighton' or 'haywards-heath'.",
          400,
          { received: rawLocation.slice(0, 120) },
        ),
      };
    }

    location = candidate;
  }

  let page = 1;

  if (rawPage !== null && rawPage.trim() !== "") {
    // Reject "2.5", "abc" and "1e3" rather than silently coercing them, so a
    // consumer with a bug finds out about it.
    if (!/^\d{1,6}$/.test(rawPage.trim())) {
      return {
        ok: false,
        response: apiError(
          "invalid_page",
          "The page parameter must be a whole number of 1 or more.",
          400,
          { received: rawPage.slice(0, 120) },
        ),
      };
    }

    page = Number(rawPage.trim());

    if (page < 1) {
      return {
        ok: false,
        response: apiError(
          "invalid_page",
          "The page parameter must be a whole number of 1 or more.",
          400,
          { received: rawPage.slice(0, 120) },
        ),
      };
    }
  }

  let limit = DEFAULT_PAGE_SIZE;

  if (rawLimit !== null && rawLimit.trim() !== "") {
    if (!/^\d{1,4}$/.test(rawLimit.trim())) {
      return {
        ok: false,
        response: apiError(
          "invalid_limit",
          `The limit parameter must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
          400,
          { received: rawLimit.slice(0, 120) },
        ),
      };
    }

    limit = Number(rawLimit.trim());

    if (limit < 1 || limit > MAX_PAGE_SIZE) {
      return {
        ok: false,
        response: apiError(
          "invalid_limit",
          `The limit parameter must be a whole number between 1 and ${MAX_PAGE_SIZE}.`,
          400,
          { received: rawLimit.slice(0, 120), maximum: MAX_PAGE_SIZE },
        ),
      };
    }
  }

  let includeContent = false;

  if (rawContent !== null && rawContent.trim() !== "") {
    const mode = rawContent.trim().toLowerCase();

    if (mode !== "full" && mode !== "summary") {
      return {
        ok: false,
        response: apiError(
          "invalid_content_mode",
          "The content parameter must be either 'summary' (default) or 'full'.",
          400,
          { received: rawContent.slice(0, 120) },
        ),
      };
    }

    includeContent = mode === "full";
  }

  return { ok: true, value: { location, page, limit, includeContent } };
}
