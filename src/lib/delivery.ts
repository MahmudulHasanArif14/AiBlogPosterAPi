import type { SupabaseClient } from "@supabase/supabase-js";
import { siteUrl } from "./config";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signatureHeaderValue,
  type DeliveryPayload,
} from "./webhook-signature";

// Dispatching queued publication notifications to the location websites.
//
// No Next.js import, so the scheduled worker can run this outside a Next
// runtime. The queue itself lives in Postgres (see the content_delivery_queue
// migration); this file is only the part that talks HTTP.

/**
 * How long one webhook request may take.
 *
 * A receiver that revalidates a few cache tags answers in well under a second.
 * Eight seconds is generous for that while leaving room to attempt several
 * deliveries inside a 60-second function budget. A receiver that is slower
 * than this is a receiver that is in trouble, and the right response is to
 * retry it later rather than hold the scheduler open.
 */
export const DELIVERY_TIMEOUT_MS = Number(
  process.env.DELIVERY_TIMEOUT_MS ?? 8_000,
);

/** How many deliveries one scheduler pass will attempt. */
export const DELIVERY_BATCH_SIZE = Number(
  process.env.DELIVERY_BATCH_SIZE ?? 10,
);

/**
 * How far back the reconciler looks for published articles with no delivery.
 *
 * This is the overlap that makes the fallback reliable. It is much larger than
 * the scheduler interval on purpose: a window only slightly larger than the
 * interval means one skipped run, one slow run or a few seconds of clock
 * difference can step over an article and never look at it again. Two days of
 * overlap costs one cheap indexed anti-join and survives an outage over a
 * weekend.
 *
 * It is also why there is no stored cursor to corrupt: an article stays visible
 * to the reconciler until a delivery row exists for it, so a failed request
 * cannot advance anything past it.
 */
export const RECONCILE_WINDOW_HOURS = Number(
  process.env.RECONCILE_WINDOW_HOURS ?? 48,
);

/** Cap on how many missed articles one reconciler pass will enqueue. */
export const RECONCILE_BATCH_SIZE = Number(
  process.env.RECONCILE_BATCH_SIZE ?? 25,
);

export type DeliveryTarget = {
  locationSlug: string;
  url: string;
  secret: string;
};

/**
 * Turn a location slug into its environment-variable suffix.
 * 'haywards-heath' -> 'HAYWARDS_HEATH'
 */
export function envSuffix(locationSlug: string) {
  return locationSlug.toUpperCase().replace(/-/g, "_");
}

export type TargetLookup =
  | { ok: true; target: DeliveryTarget }
  | { ok: false; reason: "not_configured" | "invalid_url" | "insecure_url"; detail: string };

/**
 * Resolve where a location's webhook goes, from the server environment.
 *
 * Endpoints and secrets are configuration, not data: keeping them out of
 * Postgres means a database dump never contains a signing key, and adding the
 * next location website is an environment change rather than a migration.
 *
 * A location with no configured endpoint is not an error. Most of the thirteen
 * locations have no website yet, and the correct behaviour is to skip them
 * quietly rather than accumulate dead queue rows.
 */
export function resolveTarget(
  locationSlug: string,
  env: NodeJS.ProcessEnv = process.env,
): TargetLookup {
  const suffix = envSuffix(locationSlug);
  const url = env[`DELIVERY_WEBHOOK_URL_${suffix}`]?.trim();
  const secret = env[`DELIVERY_WEBHOOK_SECRET_${suffix}`]?.trim();

  if (!url || !secret) {
    return {
      ok: false,
      reason: "not_configured",
      detail: `DELIVERY_WEBHOOK_URL_${suffix} and DELIVERY_WEBHOOK_SECRET_${suffix} are not both set`,
    };
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return {
      ok: false,
      reason: "invalid_url",
      detail: `DELIVERY_WEBHOOK_URL_${suffix} is not a valid absolute URL`,
    };
  }

  // The signature protects integrity, not confidentiality, and the shared
  // secret must never cross the network in the clear. http:// is refused
  // outright except against a loopback host, which is how the integration is
  // exercised locally.
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";

  if (parsed.protocol !== "https:" && !loopback) {
    return {
      ok: false,
      reason: "insecure_url",
      detail: `DELIVERY_WEBHOOK_URL_${suffix} must use https (http is allowed only for localhost)`,
    };
  }

  return { ok: true, target: { locationSlug, url: parsed.toString(), secret } };
}

/** Every location that currently has a working webhook configured. */
export function configuredTargets(
  locationSlugs: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const targets: DeliveryTarget[] = [];
  const skipped: { locationSlug: string; reason: string; detail: string }[] = [];

  for (const slug of locationSlugs) {
    const lookup = resolveTarget(slug, env);

    if (lookup.ok) {
      targets.push(lookup.target);
    } else {
      skipped.push({
        locationSlug: slug,
        reason: lookup.reason,
        detail: lookup.detail,
      });
    }
  }

  return { targets, skipped };
}

export type ClaimedDelivery = {
  delivery_id: string;
  post_id: string;
  attempts: number;
  max_attempts: number;
  event: "published" | "updated";
  idempotency_key: string;
  location_slug: string;
  post_slug: string;
  post_title: string;
  post_published_at: string | null;
  post_updated_at: string | null;
  post_canonical_url: string | null;
};

export function buildPayload(
  row: ClaimedDelivery,
  sentAt = new Date(),
): DeliveryPayload {
  const base = siteUrl();

  return {
    event: row.event,
    location: row.location_slug,
    slug: row.post_slug,
    postId: row.post_id,
    title: row.post_title,
    publishedAt: row.post_published_at,
    updatedAt: row.post_updated_at,
    canonicalUrl: row.post_canonical_url,
    contentUrl: `${base}/api/posts/${row.post_slug}`,
    deliveryId: row.delivery_id,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempts,
    sentAt: sentAt.toISOString(),
  };
}

export type AttemptResult = {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
};

/**
 * One signed HTTP attempt. No retry logic lives here: a failure is reported to
 * the queue, which owns the backoff schedule, so the same policy applies
 * whether the attempt came from the scheduler or a manual replay.
 */
export async function attemptDelivery(
  target: DeliveryTarget,
  payload: DeliveryPayload,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AttemptResult> {
  const timeoutMs = options.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  // Serialise once. This exact string is what gets signed and what gets sent,
  // so the receiver's HMAC over the raw body can only agree.
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(target.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "WesternCarsContent/1.0 (+https://content.westerncars.com)",
        [SIGNATURE_HEADER]: signatureHeaderValue(
          rawBody,
          target.secret,
          timestamp,
        ),
        [TIMESTAMP_HEADER]: String(timestamp),
        [DELIVERY_HEADER]: payload.deliveryId,
        [IDEMPOTENCY_HEADER]: payload.idempotencyKey,
        [EVENT_HEADER]: payload.event,
      },
      body: rawBody,
      // Never let a CDN or the runtime serve a cached response to a POST that
      // is supposed to cause a side effect.
      cache: "no-store",
    });

    if (response.ok) {
      return { ok: true, statusCode: response.status, error: null };
    }

    // Read a little of the body for the operator, and cap it: an HTML error
    // page from a misconfigured host would otherwise fill last_error.
    let detail = "";

    try {
      detail = (await response.text()).slice(0, 300);
    } catch {
      detail = "";
    }

    // 4xx other than 408/429 means the receiver understood and refused. It is
    // still reported as a failure so the backoff and the dead-letter state
    // apply, rather than marking a rejected delivery as delivered.
    return {
      ok: false,
      statusCode: response.status,
      error: `receiver responded ${response.status}${detail ? `: ${detail}` : ""}`,
    };
  } catch (error) {
    const aborted =
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError");

    return {
      ok: false,
      statusCode: null,
      error: aborted
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "unknown transport error",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the database to record that a location website is owed a notification.
 *
 * Called on both publish paths. It never throws: a publication that succeeded
 * must not be reported as a failure because the outbox insert had a hiccup,
 * and the reconciler will pick the article up within one interval anyway. That
 * is the entire reason the reconciler exists.
 */
export async function enqueueDelivery(
  db: SupabaseClient,
  postId: string,
  event: "published" | "updated" = "published",
  origin: "publish" | "reconcile" | "manual" = "publish",
) {
  try {
    const { data, error } = await db.rpc("enqueue_content_delivery", {
      p_post_id: postId,
      p_event: event,
      p_origin: origin,
    });

    if (error) {
      console.error("delivery_enqueue_failed:", error.message);
      return { ok: false as const, error: error.message };
    }

    const result = (data ?? {}) as Record<string, unknown>;

    if (result.error) {
      // 'post_not_published' here is the database refusing to distribute a
      // draft. It is correct behaviour, not a fault.
      console.warn("delivery_enqueue_refused:", result.error, result.status);
      return { ok: false as const, error: String(result.error) };
    }

    return {
      ok: true as const,
      deliveryId: String(result.deliveryId),
      created: result.created === true,
    };
  } catch (error) {
    console.error(
      "delivery_enqueue_threw:",
      error instanceof Error ? error.message : "unknown error",
    );

    return { ok: false as const, error: "enqueue_threw" };
  }
}

/**
 * Drain the due part of the queue: claim, send, record.
 *
 * Deliveries run in parallel because they go to different hosts and the
 * scheduler has a bounded time budget. `Promise.allSettled`, not `all`: one
 * unreachable website must not abandon the others' result-recording and leave
 * their rows stuck in 'delivering' until the lease expires.
 */
export async function dispatchDueDeliveries(
  db: SupabaseClient,
  options: {
    limit?: number;
    now?: Date;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DELIVERY_BATCH_SIZE;
  const env = options.env ?? process.env;

  const { data, error } = await db.rpc("claim_content_deliveries", {
    p_limit: limit,
    p_now: now.toISOString(),
    // The lease must outlive the worst case for one attempt, or a second
    // scheduler run could reclaim a row whose request is still in flight and
    // send it twice.
    p_lease_seconds: Math.ceil(
      ((options.timeoutMs ?? DELIVERY_TIMEOUT_MS) * 4) / 1000,
    ),
  });

  if (error) {
    throw new Error(`claim_failed: ${error.message}`);
  }

  const claimed = (data ?? []) as ClaimedDelivery[];

  const outcomes = await Promise.allSettled(
    claimed.map(async (row) => {
      const lookup = resolveTarget(row.location_slug, env);

      if (!lookup.ok) {
        // Not a transport failure. Record it so the row backs off instead of
        // being retried every single pass, and so the reason is visible.
        await db.rpc("mark_delivery_result", {
          p_delivery_id: row.delivery_id,
          p_ok: false,
          p_status_code: null,
          p_error: `${lookup.reason}: ${lookup.detail}`,
          p_now: new Date().toISOString(),
        });

        return {
          deliveryId: row.delivery_id,
          location: row.location_slug,
          slug: row.post_slug,
          ok: false,
          skipped: true,
          error: lookup.reason,
        };
      }

      const result = await attemptDelivery(
        lookup.target,
        buildPayload(row, now),
        { timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl },
      );

      await db.rpc("mark_delivery_result", {
        p_delivery_id: row.delivery_id,
        p_ok: result.ok,
        p_status_code: result.statusCode,
        p_error: result.error,
        p_now: new Date().toISOString(),
      });

      return {
        deliveryId: row.delivery_id,
        location: row.location_slug,
        slug: row.post_slug,
        attempt: row.attempts,
        ok: result.ok,
        skipped: false,
        statusCode: result.statusCode,
        error: result.error,
      };
    }),
  );

  const results = outcomes.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          deliveryId: claimed[index]?.delivery_id ?? "unknown",
          location: claimed[index]?.location_slug ?? "unknown",
          slug: claimed[index]?.post_slug ?? "unknown",
          ok: false,
          skipped: false,
          error:
            outcome.reason instanceof Error
              ? outcome.reason.message
              : "dispatch threw",
        },
  );

  return {
    claimed: claimed.length,
    delivered: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * The fallback sweep: published articles that have no delivery row at all.
 *
 * Returns what it enqueued so the scheduler can log it. A non-empty result is
 * the signal that webhooks are being missed, which is worth noticing even
 * though the article does get through.
 */
export async function reconcileMissedDeliveries(
  db: SupabaseClient,
  options: { windowHours?: number; limit?: number; now?: Date } = {},
) {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? RECONCILE_WINDOW_HOURS;
  const since = new Date(now.getTime() - windowHours * 3_600_000);

  const { data, error } = await db.rpc("reconcile_content_deliveries", {
    p_since: since.toISOString(),
    p_limit: options.limit ?? RECONCILE_BATCH_SIZE,
    p_origin: "reconcile",
  });

  if (error) {
    throw new Error(`reconcile_failed: ${error.message}`);
  }

  const rows = (data ?? []) as {
    post_id: string;
    post_slug: string;
    location_slug: string;
    delivery_id: string;
    created: boolean;
  }[];

  return {
    since: since.toISOString(),
    windowHours,
    examined: rows.length,
    enqueued: rows.filter((row) => row.created),
  };
}
