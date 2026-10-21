-- Durable delivery of publication events to the per-location websites.
--
-- Additive and rerunnable. It creates one table and five functions, drops
-- nothing and rewrites no existing content.
--
-- Design notes:
--   * Webhook URLs and signing secrets are NOT stored here. They live in the
--     platform's server-only environment, so a database dump never contains a
--     signing key. This table records only *that* a location must be told
--     about a post, and how that attempt went.
--   * One row per (post, event) is enforced by a unique index, so an article
--     that publishes, gets reconciled and gets re-enqueued still produces a
--     single delivery. Combined with the receiver's own idempotency key, a
--     website cannot be told about the same publication twice.
--   * Claiming uses FOR UPDATE SKIP LOCKED, so two overlapping scheduler runs
--     divide the queue instead of fighting over it or double-sending.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The queue
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.content_deliveries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    location_id uuid NOT NULL REFERENCES public.locations(id),

    -- Why the website is being notified. 'published' is the first publication;
    -- 'updated' is a later edit to an already-published article.
    event text NOT NULL DEFAULT 'published'
        CHECK (event IN ('published', 'updated')),

    status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'delivering', 'delivered', 'failed', 'dead')),

    attempts integer NOT NULL DEFAULT 0,
    max_attempts integer NOT NULL DEFAULT 8,

    -- When this row next becomes eligible. Exponential backoff writes here.
    next_attempt_at timestamptz NOT NULL DEFAULT now(),

    -- Lease held by an in-flight attempt, so a scheduler run that is killed
    -- mid-request does not strand the row in 'delivering' forever.
    leased_until timestamptz,

    -- Stable value the receiver dedupes on. Derived from the post and event
    -- and never changed, so a retry of a request the receiver already applied
    -- is recognised as the same notification.
    idempotency_key text NOT NULL,

    last_error text,
    last_status_code integer,
    delivered_at timestamptz,

    -- How this row came to exist: the publish path, or the reconciler noticing
    -- a missed webhook. This is what tells "webhooks are broken" apart from
    -- "webhooks are fine" without reading application logs.
    origin text NOT NULL DEFAULT 'publish'
        CHECK (origin IN ('publish', 'reconcile', 'manual')),

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The duplicate-prevention guarantee. Everything else is an optimisation.
CREATE UNIQUE INDEX IF NOT EXISTS content_deliveries_one_per_post_event
    ON public.content_deliveries (post_id, event);

CREATE UNIQUE INDEX IF NOT EXISTS content_deliveries_idempotency_key
    ON public.content_deliveries (idempotency_key);

-- Drives the claim query: due work, oldest first.
CREATE INDEX IF NOT EXISTS content_deliveries_due_idx
    ON public.content_deliveries (next_attempt_at)
    WHERE status IN ('queued', 'failed', 'delivering');

CREATE INDEX IF NOT EXISTS content_deliveries_location_status_idx
    ON public.content_deliveries (location_id, status);

ALTER TABLE public.content_deliveries ENABLE ROW LEVEL SECURITY;

-- No policies: this is operational state reached only through the service-role
-- key on the server. anon and authenticated get nothing.
REVOKE ALL ON TABLE public.content_deliveries FROM anon, authenticated;

-- Granted explicitly rather than left to Supabase's default privileges on the
-- public schema. /api/admin/deliveries reads and updates this table directly
-- rather than through an RPC, so the service role needs table privileges and
-- not merely EXECUTE on the functions below.
GRANT ALL ON TABLE public.content_deliveries TO service_role;

COMMENT ON TABLE public.content_deliveries IS
    'Durable outbox of publication notifications owed to each location website. One row per (post, event). Secrets are not stored here.';

-- ---------------------------------------------------------------------------
-- 2. Enqueue
-- ---------------------------------------------------------------------------
--
-- Called on the publish path and by the reconciler. Safe to call repeatedly:
-- the unique index turns a second call into a no-op that returns the existing
-- row, so the caller never has to check first.
--
-- A delivery that already succeeded is deliberately NOT reopened. A post that
-- is genuinely edited later gets an 'updated' event instead.

CREATE OR REPLACE FUNCTION public.enqueue_content_delivery(
    p_post_id uuid,
    p_event text DEFAULT 'published',
    p_origin text DEFAULT 'publish'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_location_id uuid;
    v_status text;
    v_slug text;
    v_row public.content_deliveries;
BEGIN
    SELECT location_id, status, slug
      INTO v_location_id, v_status, v_slug
      FROM public.posts
     WHERE id = p_post_id;

    IF v_location_id IS NULL THEN
        RETURN jsonb_build_object('error', 'post_not_found');
    END IF;

    -- The hard rule the whole brief rests on: only published articles are ever
    -- distributed. Enforced here, in the database, so no application path can
    -- enqueue a draft or a held article by mistake.
    IF v_status <> 'published' THEN
        RETURN jsonb_build_object(
            'error', 'post_not_published',
            'status', v_status
        );
    END IF;

    INSERT INTO public.content_deliveries (
        post_id, location_id, event, origin, idempotency_key
    )
    VALUES (
        p_post_id,
        v_location_id,
        p_event,
        p_origin,
        -- Deterministic in the post and event. md5() is a pg_catalog builtin,
        -- so this does not depend on which schema pgcrypto is installed into.
        -- It is a dedupe key, not a security primitive.
        md5(p_post_id::text || ':' || p_event)
    )
    ON CONFLICT (post_id, event) DO NOTHING
    RETURNING * INTO v_row;

    IF v_row.id IS NULL THEN
        SELECT * INTO v_row
          FROM public.content_deliveries
         WHERE post_id = p_post_id AND event = p_event;

        RETURN jsonb_build_object(
            'deliveryId', v_row.id,
            'status', v_row.status,
            'created', false,
            'slug', v_slug
        );
    END IF;

    RETURN jsonb_build_object(
        'deliveryId', v_row.id,
        'status', v_row.status,
        'created', true,
        'slug', v_slug
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Claim due deliveries
-- ---------------------------------------------------------------------------
--
-- Returns the post fields to send along with the rows, so the dispatcher needs
-- one round trip rather than one per delivery. SKIP LOCKED means a second
-- scheduler run picks up different rows instead of blocking.
--
-- A 'delivering' row whose lease has expired is reclaimable: the previous
-- attempt died without reporting. That is the only way a row leaves
-- 'delivering' other than a result being recorded.

CREATE OR REPLACE FUNCTION public.claim_content_deliveries(
    p_limit integer DEFAULT 10,
    p_now timestamptz DEFAULT now(),
    p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
    delivery_id uuid,
    post_id uuid,
    attempts integer,
    max_attempts integer,
    event text,
    idempotency_key text,
    location_slug text,
    post_slug text,
    post_title text,
    post_published_at timestamptz,
    post_updated_at timestamptz,
    post_canonical_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT d.id
          FROM public.content_deliveries AS d
         WHERE d.attempts < d.max_attempts
           AND d.next_attempt_at <= p_now
           AND (
                 d.status IN ('queued', 'failed')
                 OR (d.status = 'delivering'
                     AND (d.leased_until IS NULL OR d.leased_until <= p_now))
               )
         ORDER BY d.next_attempt_at ASC, d.created_at ASC
         LIMIT greatest(p_limit, 1)
         FOR UPDATE SKIP LOCKED
    ),
    claimed AS (
        UPDATE public.content_deliveries AS d
           SET status = 'delivering',
               attempts = d.attempts + 1,
               leased_until = p_now
                   + make_interval(secs => greatest(p_lease_seconds, 10)),
               updated_at = p_now
          FROM due
         WHERE d.id = due.id
        RETURNING d.*
    )
    SELECT c.id,
           c.post_id,
           c.attempts,
           c.max_attempts,
           c.event,
           c.idempotency_key,
           l.slug,
           p.slug,
           p.title,
           p.published_at,
           p.updated_at,
           p.canonical_url
      FROM claimed AS c
      JOIN public.posts AS p ON p.id = c.post_id
      JOIN public.locations AS l ON l.id = c.location_id
     -- A post unpublished between enqueue and dispatch must not be announced.
     -- It stays claimed and is resolved by mark_delivery_result.
     WHERE p.status = 'published';
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Record the outcome
-- ---------------------------------------------------------------------------
--
-- Backoff is computed in the database so every caller gets the same schedule:
-- 30s, 1m, 2m, 4m, ... capped at one hour. A row that exhausts its attempts
-- becomes 'dead' and stops consuming scheduler budget, while staying visible.

CREATE OR REPLACE FUNCTION public.mark_delivery_result(
    p_delivery_id uuid,
    p_ok boolean,
    p_status_code integer DEFAULT NULL,
    p_error text DEFAULT NULL,
    p_now timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_row public.content_deliveries;
    v_delay integer;
    v_terminal boolean;
BEGIN
    SELECT * INTO v_row
      FROM public.content_deliveries
     WHERE id = p_delivery_id
     FOR UPDATE;

    IF v_row.id IS NULL THEN
        RETURN jsonb_build_object('error', 'delivery_not_found');
    END IF;

    IF p_ok THEN
        UPDATE public.content_deliveries
           SET status = 'delivered',
               delivered_at = p_now,
               leased_until = NULL,
               last_error = NULL,
               last_status_code = p_status_code,
               updated_at = p_now
         WHERE id = p_delivery_id;

        RETURN jsonb_build_object('status', 'delivered');
    END IF;

    -- 30 seconds doubling per attempt, capped at 3600.
    v_delay := least(
        (30 * power(2, greatest(v_row.attempts - 1, 0)))::integer,
        3600
    );

    v_terminal := v_row.attempts >= v_row.max_attempts;

    UPDATE public.content_deliveries
       SET status = CASE WHEN v_terminal THEN 'dead' ELSE 'failed' END,
           next_attempt_at = p_now + make_interval(secs => v_delay),
           leased_until = NULL,
           last_error = left(coalesce(p_error, 'unknown error'), 2000),
           last_status_code = p_status_code,
           updated_at = p_now
     WHERE id = p_delivery_id;

    RETURN jsonb_build_object(
        'status', CASE WHEN v_terminal THEN 'dead' ELSE 'failed' END,
        'attempts', v_row.attempts,
        'maxAttempts', v_row.max_attempts,
        'retryInSeconds', v_delay
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Reconcile: published articles nobody has been told about
-- ---------------------------------------------------------------------------
--
-- The fallback path. It answers one question — "which published articles has
-- no delivery row?" — by an anti-join against the queue. That needs no stored
-- cursor and cannot skip a row because of a clock difference or a failed
-- request: a row stays visible to this query until a delivery exists for it.
--
-- p_since bounds the scan so the query stays cheap as the archive grows. The
-- scheduler passes a window several times its own interval, and p_since => NULL
-- does a full sweep for a manual catch-up.

CREATE OR REPLACE FUNCTION public.reconcile_content_deliveries(
    p_since timestamptz DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_origin text DEFAULT 'reconcile'
)
RETURNS TABLE (
    post_id uuid,
    post_slug text,
    location_slug text,
    delivery_id uuid,
    created boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    v_post record;
    v_result jsonb;
BEGIN
    FOR v_post IN
        SELECT p.id, p.slug, l.slug AS location_slug
          FROM public.posts AS p
          JOIN public.locations AS l ON l.id = p.location_id
         WHERE p.status = 'published'
           AND (p_since IS NULL OR p.published_at >= p_since)
           AND NOT EXISTS (
                 SELECT 1
                   FROM public.content_deliveries AS d
                  WHERE d.post_id = p.id
                    AND d.event = 'published'
               )
         ORDER BY p.published_at ASC NULLS LAST
         LIMIT greatest(p_limit, 1)
    LOOP
        v_result := public.enqueue_content_delivery(
            v_post.id, 'published', p_origin
        );

        IF v_result ? 'deliveryId' THEN
            RETURN QUERY SELECT
                v_post.id,
                v_post.slug,
                v_post.location_slug,
                (v_result->>'deliveryId')::uuid,
                (v_result->>'created')::boolean;
        END IF;
    END LOOP;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Operational snapshot
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.delivery_health(p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $function$
    SELECT jsonb_build_object(
        'queued', count(*) FILTER (WHERE status = 'queued'),
        'delivering', count(*) FILTER (WHERE status = 'delivering'),
        'delivered', count(*) FILTER (WHERE status = 'delivered'),
        'failed', count(*) FILTER (WHERE status = 'failed'),
        'dead', count(*) FILTER (WHERE status = 'dead'),
        'due_now', count(*) FILTER (
            WHERE status IN ('queued', 'failed')
              AND next_attempt_at <= p_now
              AND attempts < max_attempts
        ),
        'oldest_undelivered', min(created_at) FILTER (
            WHERE status <> 'delivered'
        ),
        'published_without_delivery', (
            SELECT count(*)
              FROM public.posts AS p
             WHERE p.status = 'published'
               AND NOT EXISTS (
                     SELECT 1 FROM public.content_deliveries AS d
                      WHERE d.post_id = p.id AND d.event = 'published'
                   )
        )
    )
    FROM public.content_deliveries;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Least-privilege access
-- ---------------------------------------------------------------------------
--
-- PUBLIC has to be named here, not just anon and authenticated.
--
-- Postgres grants EXECUTE to PUBLIC on every new function, and revoking from
-- anon does NOT take away a privilege anon holds *through* PUBLIC. Every
-- function below is SECURITY DEFINER and lives in the public schema, so
-- PostgREST exposes it at /rest/v1/rpc/<name>: leaving the PUBLIC grant in
-- place would let the anon key call them, bypassing the table privileges
-- above entirely. Three of them mutate the queue, and delivery_health leaks
-- queue counts. This is the same privilege-escalation path the scheduling
-- functions in 20261020190100 are guarded against, guarded the same way.
--
-- The GRANTs are therefore not optional. Revoking from PUBLIC without them
-- would strip the application's own access and break every delivery.

REVOKE ALL ON FUNCTION public.enqueue_content_delivery(uuid, text, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_content_deliveries(integer, timestamptz, integer)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_delivery_result(uuid, boolean, integer, text, timestamptz)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_content_deliveries(timestamptz, integer, text)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delivery_health(timestamptz)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_content_delivery(uuid, text, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_content_deliveries(integer, timestamptz, integer)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_delivery_result(uuid, boolean, integer, text, timestamptz)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_content_deliveries(timestamptz, integer, text)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.delivery_health(timestamptz)
    TO service_role;

COMMIT;
