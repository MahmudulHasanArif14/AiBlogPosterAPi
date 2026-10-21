import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attemptDelivery,
  buildPayload,
  configuredTargets,
  dispatchDueDeliveries,
  enqueueDelivery,
  envSuffix,
  reconcileMissedDeliveries,
  type ClaimedDelivery,
} from "../src/lib/delivery";
import {
  DEFAULT_TOLERANCE_SECONDS,
  SIGNATURE_VERSION,
  sign,
  signatureHeaderValue,
  verifyWebhook,
} from "../src/lib/webhook-signature";

const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

function claimed(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  return {
    delivery_id: "11111111-1111-4111-8111-111111111111",
    post_id: "22222222-2222-4222-8222-222222222222",
    attempts: 1,
    max_attempts: 8,
    event: "published",
    idempotency_key: "abc123",
    location_slug: "brighton",
    post_slug: "brighton-to-gatwick-taxi-cost",
    post_title: "How much does a taxi from Brighton to Gatwick cost?",
    post_published_at: "2026-10-21T09:00:00.000Z",
    post_updated_at: "2026-10-21T09:00:00.000Z",
    post_canonical_url:
      "https://content.westerncars.com/posts/brighton-to-gatwick-taxi-cost",
    ...overrides,
  };
}

/**
 * A fake Supabase client that records every RPC call.
 *
 * The real queue semantics (SKIP LOCKED, the unique index, the backoff
 * arithmetic) live in SQL and are asserted against a real Postgres by the
 * migration checks in the manual setup steps, not here. What these tests pin
 * down is the application contract: that the right RPC is called with the right
 * arguments, and that a failure path records a failure instead of silently
 * dropping a notification.
 */
function fakeDb(
  handlers: Record<string, (args: Record<string, unknown>) => unknown> = {},
) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];

  const db = {
    calls,
    rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });

      const handler = handlers[fn];

      if (!handler) {
        return Promise.resolve({ data: null, error: null });
      }

      try {
        return Promise.resolve({ data: handler(args), error: null });
      } catch (error) {
        return Promise.resolve({
          data: null,
          error: { message: (error as Error).message },
        });
      }
    },
    callsTo(fn: string) {
      return calls.filter((call) => call.fn === fn);
    },
  };

  return db as unknown as SupabaseClient & {
    calls: typeof calls;
    callsTo: (fn: string) => typeof calls;
  };
}

// ---------------------------------------------------------------------------
// Request signing and verification
// ---------------------------------------------------------------------------

describe("webhook signatures", () => {
  const body = JSON.stringify({ event: "published", slug: "a-slug" });
  const now = 1_793_000_000;

  test("a correctly signed request verifies", () => {
    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      signatureHeader: signatureHeaderValue(body, SECRET, now),
      timestampHeader: String(now),
      now,
    });

    assert.deepEqual(result, { ok: true, timestamp: now });
  });

  test("a signature made with a different secret is rejected", () => {
    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      signatureHeader: signatureHeaderValue(body, "wrong-secret", now),
      timestampHeader: String(now),
      now,
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
  });

  test("a tampered body is rejected even with a valid-looking signature", () => {
    const signature = signatureHeaderValue(body, SECRET, now);

    const result = verifyWebhook({
      rawBody: JSON.stringify({ event: "published", slug: "a-different-slug" }),
      secret: SECRET,
      signatureHeader: signature,
      timestampHeader: String(now),
      now,
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
  });

  test("moving the timestamp invalidates the signature", () => {
    // The timestamp is inside the signed string, so an attacker cannot take a
    // captured signature and refresh its timestamp to make it current again.
    const signature = signatureHeaderValue(body, SECRET, now);

    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      signatureHeader: signature,
      timestampHeader: String(now + 60),
      now: now + 60,
    });

    assert.deepEqual(result, { ok: false, reason: "invalid_signature" });
  });

  test("a missing signature or timestamp is rejected", () => {
    assert.deepEqual(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        signatureHeader: null,
        timestampHeader: String(now),
        now,
      }),
      { ok: false, reason: "missing_signature" },
    );

    assert.deepEqual(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        signatureHeader: signatureHeaderValue(body, SECRET, now),
        timestampHeader: null,
        now,
      }),
      { ok: false, reason: "missing_timestamp" },
    );
  });

  test("an unconfigured secret fails closed", () => {
    // A receiver deployed without its secret must reject everything, not
    // accept everything.
    assert.deepEqual(
      verifyWebhook({
        rawBody: body,
        secret: undefined,
        signatureHeader: signatureHeaderValue(body, SECRET, now),
        timestampHeader: String(now),
        now,
      }),
      { ok: false, reason: "not_configured" },
    );
  });

  test("an unknown signature version is rejected", () => {
    assert.deepEqual(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        signatureHeader: `v9=${sign(body, SECRET, now)}`,
        timestampHeader: String(now),
        now,
      }),
      { ok: false, reason: "unsupported_signature_version" },
    );
  });

  test("a malformed signature is rejected before any comparison", () => {
    assert.deepEqual(
      verifyWebhook({
        rawBody: body,
        secret: SECRET,
        signatureHeader: `${SIGNATURE_VERSION}=not-hex`,
        timestampHeader: String(now),
        now,
      }),
      { ok: false, reason: "malformed_signature" },
    );
  });
});

describe("replay protection", () => {
  const body = JSON.stringify({ event: "published", slug: "a-slug" });
  const now = 1_793_000_000;

  test("a request older than the tolerance is rejected", () => {
    const old = now - DEFAULT_TOLERANCE_SECONDS - 1;

    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      // Correctly signed for its own timestamp. The only thing wrong is age,
      // which is exactly the captured-and-replayed case.
      signatureHeader: signatureHeaderValue(body, SECRET, old),
      timestampHeader: String(old),
      now,
    });

    assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
  });

  test("a request from the future is rejected too", () => {
    const ahead = now + DEFAULT_TOLERANCE_SECONDS + 1;

    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      signatureHeader: signatureHeaderValue(body, SECRET, ahead),
      timestampHeader: String(ahead),
      now,
    });

    // Without the absolute-value check, a forward-skewed sender could mint
    // requests that stay valid for hours.
    assert.deepEqual(result, { ok: false, reason: "stale_timestamp" });
  });

  test("a request just inside the tolerance is accepted", () => {
    const edge = now - DEFAULT_TOLERANCE_SECONDS;

    const result = verifyWebhook({
      rawBody: body,
      secret: SECRET,
      signatureHeader: signatureHeaderValue(body, SECRET, edge),
      timestampHeader: String(edge),
      now,
    });

    assert.equal(result.ok, true);
  });

  test("a non-numeric timestamp is rejected rather than coerced", () => {
    // Number("") is 0 and Number("1e9") is a billion. Either would hand an
    // attacker a timestamp they did not have to guess.
    //
    // "" is absent rather than malformed and is covered by the missing-header
    // test above; everything here is present but not a plain integer.
    for (const value of [" ", "abc", "1e9", "-100", "12.5", "0x10", "+5"]) {
      const result = verifyWebhook({
        rawBody: body,
        secret: SECRET,
        signatureHeader: signatureHeaderValue(body, SECRET, now),
        timestampHeader: value,
        now,
      });

      assert.equal(result.ok, false, `expected ${JSON.stringify(value)} to fail`);
      assert.equal(
        (result as { reason: string }).reason,
        "malformed_timestamp",
        `expected ${JSON.stringify(value)} to be malformed`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Target resolution and location isolation
// ---------------------------------------------------------------------------

describe("delivery targets", () => {
  test("slug to environment suffix", () => {
    assert.equal(envSuffix("brighton"), "BRIGHTON");
    assert.equal(envSuffix("haywards-heath"), "HAYWARDS_HEATH");
    assert.equal(envSuffix("east-grinstead"), "EAST_GRINSTEAD");
  });

  test("only locations with both a URL and a secret are configured", () => {
    const { targets, skipped } = configuredTargets(
      ["brighton", "crawley", "lewes"],
      {
        DELIVERY_WEBHOOK_URL_BRIGHTON: "https://brighton.example/api/revalidate-blog",
        DELIVERY_WEBHOOK_SECRET_BRIGHTON: SECRET,
        // A URL with no secret must not produce a target: an unsigned request
        // would be rejected by the receiver anyway.
        DELIVERY_WEBHOOK_URL_CRAWLEY: "https://crawley.example/api/revalidate-blog",
      } as unknown as NodeJS.ProcessEnv,
    );

    assert.equal(targets.length, 1);
    assert.equal(targets[0].locationSlug, "brighton");
    assert.deepEqual(
      skipped.map((entry) => entry.locationSlug).sort(),
      ["crawley", "lewes"],
    );
    assert.ok(skipped.every((entry) => entry.reason === "not_configured"));
  });

  test("a plaintext http endpoint is refused unless it is loopback", () => {
    const insecure = configuredTargets(["brighton"], {
      DELIVERY_WEBHOOK_URL_BRIGHTON: "http://brighton.example/api/revalidate-blog",
      DELIVERY_WEBHOOK_SECRET_BRIGHTON: SECRET,
    } as unknown as NodeJS.ProcessEnv);

    assert.equal(insecure.targets.length, 0);
    assert.equal(insecure.skipped[0].reason, "insecure_url");

    const local = configuredTargets(["brighton"], {
      DELIVERY_WEBHOOK_URL_BRIGHTON: "http://localhost:3001/api/revalidate-blog",
      DELIVERY_WEBHOOK_SECRET_BRIGHTON: SECRET,
    } as unknown as NodeJS.ProcessEnv);

    assert.equal(local.targets.length, 1);
  });

  test("each location's payload names only its own location", () => {
    // Location isolation on the sending side: a Brighton delivery must never
    // carry another location's slug, because that slug is what the receiver
    // checks before revalidating anything.
    const brighton = buildPayload(claimed({ location_slug: "brighton" }));
    const crawley = buildPayload(claimed({ location_slug: "crawley" }));

    assert.equal(brighton.location, "brighton");
    assert.equal(crawley.location, "crawley");
  });

  test("the payload carries identifiers, not article content", () => {
    const payload = buildPayload(claimed());

    // A captured webhook must leak no article body, and the website must be
    // unable to render anything the public API would not also serve.
    assert.ok(!("content" in payload));
    assert.ok(payload.contentUrl.endsWith("/api/posts/brighton-to-gatwick-taxi-cost"));
    assert.equal(payload.slug, "brighton-to-gatwick-taxi-cost");
  });
});

// ---------------------------------------------------------------------------
// One HTTP attempt: headers, timeouts, failures
// ---------------------------------------------------------------------------

describe("a single delivery attempt", () => {
  const target = {
    locationSlug: "brighton",
    url: "https://brighton.example/api/revalidate-blog",
    secret: SECRET,
  };

  test("sends a signature the receiver can verify over the exact raw body", async () => {
    // Captured into an array rather than a nullable local: a local assigned
    // only inside a callback stays narrowed to null as far as the compiler is
    // concerned.
    const sent: { body: string; headers: Record<string, string> }[] = [];

    const result = await attemptDelivery(target, buildPayload(claimed()), {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent.push({
          body: init.body as string,
          headers: init.headers as Record<string, string>,
        });

        return new Response(JSON.stringify({ revalidated: true }), {
          status: 200,
        });
      }) as unknown as typeof fetch,
    });

    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(sent.length, 1);

    const headers = sent[0].headers;

    // Verified the same way the receiver will: over the bytes that were sent.
    const verified = verifyWebhook({
      rawBody: sent[0].body,
      secret: SECRET,
      signatureHeader: headers["x-westerncars-signature"],
      timestampHeader: headers["x-westerncars-timestamp"],
    });

    assert.equal(verified.ok, true);
    assert.equal(headers["x-westerncars-event"], "published");
    assert.equal(headers["x-westerncars-idempotency-key"], "abc123");
  });

  test("a 5xx from the receiver is a failure, not a success", async () => {
    const result = await attemptDelivery(target, buildPayload(claimed()), {
      fetchImpl: (async () =>
        new Response("upstream exploded", { status: 503 })) as unknown as typeof fetch,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 503);
    assert.match(result.error ?? "", /503/);
  });

  test("a 401 from the receiver is a failure, not silently accepted", async () => {
    // If a secret is rotated on one side only, this is what happens. It must
    // retry and eventually dead-letter, not mark the article delivered.
    const result = await attemptDelivery(target, buildPayload(claimed()), {
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: "invalid_signature" }), {
          status: 401,
        })) as unknown as typeof fetch,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 401);
  });

  test("a hanging receiver is abandoned at the timeout", async () => {
    const result = await attemptDelivery(target, buildPayload(claimed()), {
      timeoutMs: 40,
      fetchImpl: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          // Honour the abort signal the way a real fetch does.
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })) as unknown as typeof fetch,
    });

    assert.equal(result.ok, false);
    assert.equal(result.statusCode, null);
    assert.match(result.error ?? "", /timed out after 40ms/);
  });

  test("a DNS or connection error is reported, not thrown", async () => {
    const result = await attemptDelivery(target, buildPayload(claimed()), {
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /fetch failed/);
  });

  test("a huge error body is truncated before it reaches the queue", async () => {
    const result = await attemptDelivery(target, buildPayload(claimed()), {
      fetchImpl: (async () =>
        new Response("x".repeat(50_000), { status: 500 })) as unknown as typeof fetch,
    });

    assert.equal(result.ok, false);
    assert.ok((result.error ?? "").length < 400);
  });
});

// ---------------------------------------------------------------------------
// Enqueueing: published versus unpublished, idempotency
// ---------------------------------------------------------------------------

describe("enqueueing a delivery", () => {
  test("a published post is enqueued", async () => {
    const db = fakeDb({
      enqueue_content_delivery: () => ({
        deliveryId: "33333333-3333-4333-8333-333333333333",
        status: "queued",
        created: true,
      }),
    });

    const result = await enqueueDelivery(db, "post-1", "published");

    assert.deepEqual(result, {
      ok: true,
      deliveryId: "33333333-3333-4333-8333-333333333333",
      created: true,
    });
  });

  test("an unpublished post is refused by the database and not enqueued", async () => {
    // The gate the whole brief rests on. The refusal comes from SQL, so no
    // application path can distribute a draft or a held article.
    for (const status of ["draft", "needs_review", "failed", "queued"]) {
      const db = fakeDb({
        enqueue_content_delivery: () => ({
          error: "post_not_published",
          status,
        }),
      });

      const result = await enqueueDelivery(db, "post-1", "published");

      assert.equal(result.ok, false, `${status} must not be enqueued`);
      assert.equal((result as { error: string }).error, "post_not_published");
    }
  });

  test("enqueueing the same publication twice yields one delivery", async () => {
    // Second call hits the unique index and comes back created:false with the
    // same id, which is what keeps a republish or a reconcile from producing a
    // second notification.
    let seen = 0;

    const db = fakeDb({
      enqueue_content_delivery: () => {
        seen += 1;

        return {
          deliveryId: "33333333-3333-4333-8333-333333333333",
          status: "queued",
          created: seen === 1,
        };
      },
    });

    const first = await enqueueDelivery(db, "post-1");
    const second = await enqueueDelivery(db, "post-1");

    assert.equal(first.ok && first.created, true);
    assert.equal(second.ok && second.created, false);
    assert.equal(
      (first as { deliveryId: string }).deliveryId,
      (second as { deliveryId: string }).deliveryId,
    );
  });

  test("a database error does not throw and does not fail the publication", async () => {
    // An article that published successfully must not be reported as failed
    // because the outbox insert had a hiccup. The reconciler recovers it.
    const db = fakeDb({
      enqueue_content_delivery: () => {
        throw new Error("connection reset");
      },
    });

    const result = await enqueueDelivery(db, "post-1");

    assert.equal(result.ok, false);
  });
});

// ---------------------------------------------------------------------------
// Dispatching the queue
// ---------------------------------------------------------------------------

describe("dispatching due deliveries", () => {
  const env = {
    DELIVERY_WEBHOOK_URL_BRIGHTON: "https://brighton.example/api/revalidate-blog",
    DELIVERY_WEBHOOK_SECRET_BRIGHTON: SECRET,
  } as unknown as NodeJS.ProcessEnv;

  test("a successful pass marks the delivery delivered exactly once", async () => {
    const db = fakeDb({
      claim_content_deliveries: () => [claimed()],
      mark_delivery_result: () => ({ status: "delivered" }),
    });

    const result = await dispatchDueDeliveries(db, {
      env,
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    });

    assert.equal(result.claimed, 1);
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 0);

    const marks = db.callsTo("mark_delivery_result");
    assert.equal(marks.length, 1);
    assert.equal(marks[0].args.p_ok, true);
  });

  test("a failed delivery is recorded as failed so backoff applies", async () => {
    const db = fakeDb({
      claim_content_deliveries: () => [claimed()],
      mark_delivery_result: () => ({ status: "failed", retryInSeconds: 30 }),
    });

    const result = await dispatchDueDeliveries(db, {
      env,
      fetchImpl: (async () =>
        new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });

    assert.equal(result.delivered, 0);
    assert.equal(result.failed, 1);

    const mark = db.callsTo("mark_delivery_result")[0];
    assert.equal(mark.args.p_ok, false);
    assert.equal(mark.args.p_status_code, 500);
  });

  test("one unreachable website does not abandon the others", async () => {
    // Promise.allSettled, not all. Otherwise a single rejection would skip the
    // result-recording for the rest and leave their rows stuck in 'delivering'
    // until the lease expired.
    const db = fakeDb({
      claim_content_deliveries: () => [
        claimed({ delivery_id: "d-1", location_slug: "brighton" }),
        claimed({ delivery_id: "d-2", location_slug: "brighton", post_slug: "second" }),
      ],
      mark_delivery_result: () => ({ status: "ok" }),
    });

    let call = 0;

    const result = await dispatchDueDeliveries(db, {
      env,
      fetchImpl: (async () => {
        call += 1;

        if (call === 1) {
          throw new TypeError("fetch failed");
        }

        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    assert.equal(result.claimed, 2);
    assert.equal(result.delivered, 1);
    assert.equal(result.failed, 1);
    // Both outcomes recorded, which is the point.
    assert.equal(db.callsTo("mark_delivery_result").length, 2);
  });

  test("a location with no configured endpoint is recorded, not retried hot", async () => {
    const db = fakeDb({
      claim_content_deliveries: () => [claimed({ location_slug: "lewes" })],
      mark_delivery_result: () => ({ status: "failed" }),
    });

    let requested = false;

    const result = await dispatchDueDeliveries(db, {
      env,
      fetchImpl: (async () => {
        requested = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });

    assert.equal(requested, false, "no request should be made with no endpoint");
    assert.equal(result.failed, 1);

    const mark = db.callsTo("mark_delivery_result")[0];
    assert.equal(mark.args.p_ok, false);
    assert.match(String(mark.args.p_error), /not_configured/);
  });

  test("the claim lease outlives the request timeout", async () => {
    // If the lease were shorter than one attempt, a second overlapping run
    // could reclaim a row whose request was still in flight and send it twice.
    const db = fakeDb({ claim_content_deliveries: () => [] });

    await dispatchDueDeliveries(db, { env, timeoutMs: 8_000 });

    const claim = db.callsTo("claim_content_deliveries")[0];
    assert.ok(
      Number(claim.args.p_lease_seconds) >= 8,
      "lease must cover at least one full attempt",
    );
  });

  test("an empty queue is a no-op", async () => {
    const db = fakeDb({ claim_content_deliveries: () => [] });

    const result = await dispatchDueDeliveries(db, { env });

    assert.deepEqual(
      { claimed: result.claimed, delivered: result.delivered, failed: result.failed },
      { claimed: 0, delivered: 0, failed: 0 },
    );
    assert.equal(db.callsTo("mark_delivery_result").length, 0);
  });

  test("a claim failure surfaces rather than reporting a successful pass", async () => {
    const db = fakeDb({
      claim_content_deliveries: () => {
        throw new Error("statement timeout");
      },
    });

    await assert.rejects(
      () => dispatchDueDeliveries(db, { env }),
      /claim_failed: statement timeout/,
    );
  });
});

// ---------------------------------------------------------------------------
// The scheduled fallback
// ---------------------------------------------------------------------------

describe("reconciling missed deliveries", () => {
  test("the lookback window overlaps the schedule many times over", async () => {
    const db = fakeDb({ reconcile_content_deliveries: () => [] });

    const now = new Date("2026-10-21T12:00:00.000Z");
    const result = await reconcileMissedDeliveries(db, { now });

    const call = db.callsTo("reconcile_content_deliveries")[0];
    const since = new Date(String(call.args.p_since));
    const hours = (now.getTime() - since.getTime()) / 3_600_000;

    // A window only slightly wider than the 10-minute interval would let one
    // skipped run, one slow run or a little clock skew step over an article.
    assert.ok(hours >= 24, `window was only ${hours} hours`);
    assert.equal(result.windowHours, hours);
  });

  test("a missed article is enqueued and reported", async () => {
    const db = fakeDb({
      reconcile_content_deliveries: () => [
        {
          post_id: "p-1",
          post_slug: "a-missed-article",
          location_slug: "brighton",
          delivery_id: "d-1",
          created: true,
        },
      ],
    });

    const result = await reconcileMissedDeliveries(db);

    assert.equal(result.examined, 1);
    assert.equal(result.enqueued.length, 1);
    assert.equal(result.enqueued[0].post_slug, "a-missed-article");
  });

  test("an article that already has a delivery is not re-enqueued", async () => {
    // created:false means the anti-join found it but the unique index already
    // held a row. It must not be counted as recovered, or the operator would
    // see a permanent false alarm.
    const db = fakeDb({
      reconcile_content_deliveries: () => [
        {
          post_id: "p-1",
          post_slug: "already-queued",
          location_slug: "brighton",
          delivery_id: "d-1",
          created: false,
        },
      ],
    });

    const result = await reconcileMissedDeliveries(db);

    assert.equal(result.examined, 1);
    assert.equal(result.enqueued.length, 0);
  });

  test("the batch size is bounded so one pass cannot run away", async () => {
    const db = fakeDb({ reconcile_content_deliveries: () => [] });

    await reconcileMissedDeliveries(db, { limit: 25 });

    assert.equal(db.callsTo("reconcile_content_deliveries")[0].args.p_limit, 25);
  });

  test("a reconcile failure surfaces instead of being reported as a clean pass", async () => {
    const db = fakeDb({
      reconcile_content_deliveries: () => {
        throw new Error("deadlock detected");
      },
    });

    await assert.rejects(
      () => reconcileMissedDeliveries(db),
      /reconcile_failed: deadlock detected/,
    );
  });
});
