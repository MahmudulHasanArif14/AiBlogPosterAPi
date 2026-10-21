import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

// The wire contract between this platform and every location website.
//
// Deliberately free of any Next.js import: the scheduled worker in scripts/
// runs outside a Next runtime, and the tests import it directly. The receiving
// website implements the verify half of this file against the same constants,
// so any change here is a breaking change to every consumer.

export const SIGNATURE_HEADER = "x-westerncars-signature";
export const TIMESTAMP_HEADER = "x-westerncars-timestamp";
export const DELIVERY_HEADER = "x-westerncars-delivery-id";
export const IDEMPOTENCY_HEADER = "x-westerncars-idempotency-key";
export const EVENT_HEADER = "x-westerncars-event";

/** Only one scheme exists so far. It is sent explicitly so a second one can be
 *  introduced without a flag day: a receiver that understands v1 and v2 can
 *  accept both while senders are rolled forward. */
export const SIGNATURE_VERSION = "v1";

/**
 * How far apart the sender's and receiver's clocks may be before a request is
 * rejected as stale.
 *
 * Five minutes is the usual choice and it is a real trade-off, not a magic
 * number: shorter and ordinary clock drift between two hosts starts rejecting
 * good requests; longer and a captured request stays replayable for longer.
 * The retry schedule in the delivery queue signs each attempt afresh, so a
 * legitimate retry is never near this bound.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * What actually gets signed.
 *
 * The timestamp is inside the signed string, which is the whole point: signing
 * only the body would let an attacker replay a captured request forever, since
 * the body alone stays valid. Binding the two together means changing either
 * one invalidates the signature.
 *
 * The version prefix stops a v2 signature over a different layout from ever
 * being mistaken for a valid v1 signature over this one.
 */
export function signingString(timestamp: number, rawBody: string) {
  return `${SIGNATURE_VERSION}:${timestamp}:${rawBody}`;
}

export function sign(rawBody: string, secret: string, timestamp: number) {
  return createHmac("sha256", secret)
    .update(signingString(timestamp, rawBody))
    .digest("hex");
}

/** The full header value, including the scheme prefix. */
export function signatureHeaderValue(
  rawBody: string,
  secret: string,
  timestamp: number,
) {
  return `${SIGNATURE_VERSION}=${sign(rawBody, secret, timestamp)}`;
}

function constantTimeEquals(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length. Comparing a buffer with itself keeps the work constant, then the
  // length check is applied to the result.
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }

  return timingSafeEqual(left, right);
}

export type VerifyFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "unsupported_signature_version"
  | "malformed_signature"
  | "invalid_signature"
  | "not_configured";

export type VerifyResult =
  | { ok: true; timestamp: number }
  | { ok: false; reason: VerifyFailure };

/**
 * Verify a received webhook.
 *
 * `rawBody` must be the exact bytes as received. Verifying a re-serialised
 * object instead is the classic way to break this: `JSON.parse` followed by
 * `JSON.stringify` can reorder keys and change number and unicode formatting,
 * and any of that produces a different HMAC.
 */
export function verifyWebhook(options: {
  rawBody: string;
  secret: string | undefined;
  signatureHeader: string | null;
  timestampHeader: string | null;
  now?: number;
  toleranceSeconds?: number;
}): VerifyResult {
  const {
    rawBody,
    secret,
    signatureHeader,
    timestampHeader,
    now = Math.floor(Date.now() / 1000),
    toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  } = options;

  if (!secret) {
    return { ok: false, reason: "not_configured" };
  }

  if (!signatureHeader) {
    return { ok: false, reason: "missing_signature" };
  }

  if (!timestampHeader) {
    return { ok: false, reason: "missing_timestamp" };
  }

  // Reject anything that is not a plain run of digits rather than coercing it.
  // Number("") is 0 and Number(" 1e9 ") is a billion, and either would hand an
  // attacker a timestamp they did not have to guess.
  if (!/^\d{1,15}$/.test(timestampHeader.trim())) {
    return { ok: false, reason: "malformed_timestamp" };
  }

  const timestamp = Number(timestampHeader.trim());

  // Absolute difference, so a request from the future is rejected too. A
  // forward-skewed sender could otherwise mint requests valid for hours.
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const [version, provided] = signatureHeader.trim().split("=", 2);

  if (version !== SIGNATURE_VERSION) {
    return { ok: false, reason: "unsupported_signature_version" };
  }

  if (!provided || !/^[0-9a-f]{64}$/i.test(provided)) {
    return { ok: false, reason: "malformed_signature" };
  }

  const expected = sign(rawBody, secret, timestamp);

  if (!constantTimeEquals(expected, provided.toLowerCase())) {
    return { ok: false, reason: "invalid_signature" };
  }

  return { ok: true, timestamp };
}

/**
 * The notification body. A website codes against this shape, so every field is
 * a commitment.
 *
 * It carries identifiers and nothing else — no article body. The receiver
 * fetches the article from the public API, which means a captured webhook
 * leaks no content, and the website can never render a version of an article
 * that the API would not also serve.
 */
export type DeliveryPayload = {
  event: "published" | "updated";
  /** Which location website this is for. The receiver rejects anything else. */
  location: string;
  slug: string;
  postId: string;
  title: string;
  publishedAt: string | null;
  updatedAt: string | null;
  /** Canonical URL on the central hub, for reference. Not the site's own. */
  canonicalUrl: string | null;
  /** Where the receiver can fetch this article. */
  contentUrl: string;
  deliveryId: string;
  idempotencyKey: string;
  attempt: number;
  sentAt: string;
};

export function newNonce() {
  return randomUUID();
}
