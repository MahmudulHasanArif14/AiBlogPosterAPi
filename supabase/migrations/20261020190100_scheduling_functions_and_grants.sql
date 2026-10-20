-- Concurrency-safe daily scheduling, bounded retries, and least-privilege
-- access for the Western Cars central content platform.
--
-- Rerunnable. Every function is CREATE OR REPLACE and no data is modified.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Approved sources need a stable key so seeding is idempotent
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS content_sources_unique_url
    ON public.content_sources (source_url)
    WHERE source_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS content_sources_approved_idx
    ON public.content_sources (approved)
    WHERE approved;

-- ---------------------------------------------------------------------------
-- 2. Claim the single daily generation slot
-- ---------------------------------------------------------------------------
--
-- One call per cron invocation. Concurrency safety comes from three layers:
--   * FOR UPDATE on the chosen locations row serialises rotation advancement;
--   * the partial unique index on (scheduled_day_london) WHERE kind='scheduled'
--     makes a second insert for the same London day impossible;
--   * the unique_violation handler converts that race into "reuse the job the
--     other invocation created" rather than an error.
--
-- The rotation cursor is the locations.last_scheduled_at column. Picking the
-- oldest value means a location can never be given a second turn until every
-- other enabled location has had one, and a newly enabled location (NULL) goes
-- to the front.

CREATE OR REPLACE FUNCTION public.claim_daily_generation_slot(
    p_now timestamptz DEFAULT now(),
    p_timezone text DEFAULT 'Europe/London'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
    v_day date := (p_now AT TIME ZONE p_timezone)::date;
    v_job public.generation_jobs;
    v_loc public.locations;
    v_angles text[] := ARRAY[
        'airport transfers and Gatwick connections',
        'rail station arrivals and onward travel',
        'practical journey planning for first-time visitors',
        'travelling with luggage, children or reduced mobility',
        'late-night and early-morning travel planning',
        'seasonal, event and school-holiday travel pressure points',
        'choosing sensibly between train, bus, walking and taxi'
    ];
    v_angle text;
    v_post_count integer;
    v_topic text;
BEGIN
    -- Reuse today's slot if one already exists, whatever its state.
    SELECT * INTO v_job
    FROM public.generation_jobs
    WHERE kind = 'scheduled'
      AND scheduled_day_london = v_day;

    IF FOUND THEN
        SELECT * INTO v_loc FROM public.locations WHERE id = v_job.location_id;

        RETURN jsonb_build_object(
            'jobId', v_job.id,
            'createdNew', false,
            'scheduledDay', v_day,
            'timezone', p_timezone,
            'locationId', v_loc.id,
            'locationSlug', v_loc.slug,
            'locationName', v_loc.name,
            'locationEnabled', v_loc.enabled,
            'topic', v_job.topic,
            'status', v_job.status,
            'attempts', v_job.attempts,
            'maxAttempts', v_job.max_attempts,
            'nextAttemptAt', v_job.next_attempt_at
        );
    END IF;

    -- Take the next turn in the rotation and lock it against a concurrent run.
    SELECT * INTO v_loc
    FROM public.locations
    WHERE enabled
    ORDER BY last_scheduled_at ASC NULLS FIRST, rotation_order ASC, slug ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('error', 'no_enabled_locations');
    END IF;

    -- Rotate the angle by how much this location already has, so repeat turns
    -- do not come back to the same brief.
    SELECT count(*) INTO v_post_count
    FROM public.posts
    WHERE location_id = v_loc.id;

    v_angle := v_angles[(v_post_count % array_length(v_angles, 1)) + 1];

    v_topic := format(
        'Write a fresh, original article for %s focused on %s. Choose one specific reader question or journey-planning problem and answer it properly. Do not repeat the angle of recent published articles for this location.',
        v_loc.name,
        v_angle
    );

    BEGIN
        INSERT INTO public.generation_jobs (
            location_id, topic, status, kind, scheduled_for, max_attempts
        )
        VALUES (v_loc.id, v_topic, 'queued', 'scheduled', p_now, 3)
        RETURNING * INTO v_job;
    EXCEPTION WHEN unique_violation THEN
        -- A concurrent invocation won today's slot. Report theirs.
        SELECT * INTO v_job
        FROM public.generation_jobs
        WHERE kind = 'scheduled'
          AND scheduled_day_london = v_day;

        SELECT * INTO v_loc FROM public.locations WHERE id = v_job.location_id;

        RETURN jsonb_build_object(
            'jobId', v_job.id,
            'createdNew', false,
            'raceLost', true,
            'scheduledDay', v_day,
            'timezone', p_timezone,
            'locationId', v_loc.id,
            'locationSlug', v_loc.slug,
            'locationName', v_loc.name,
            'locationEnabled', v_loc.enabled,
            'topic', v_job.topic,
            'status', v_job.status,
            'attempts', v_job.attempts,
            'maxAttempts', v_job.max_attempts,
            'nextAttemptAt', v_job.next_attempt_at
        );
    END;

    -- Advance the rotation cursor only once the slot is actually reserved.
    UPDATE public.locations
    SET last_scheduled_at = p_now
    WHERE id = v_loc.id;

    RETURN jsonb_build_object(
        'jobId', v_job.id,
        'createdNew', true,
        'scheduledDay', v_day,
        'timezone', p_timezone,
        'locationId', v_loc.id,
        'locationSlug', v_loc.slug,
        'locationName', v_loc.name,
        'locationEnabled', v_loc.enabled,
        'topic', v_job.topic,
        'status', v_job.status,
        'attempts', v_job.attempts,
        'maxAttempts', v_job.max_attempts,
        'nextAttemptAt', v_job.next_attempt_at
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 3. Claim a job for processing, respecting the retry budget
-- ---------------------------------------------------------------------------
--
-- Replaces the earlier version, which ignored max_attempts and next_attempt_at
-- and so would retry a permanently failing job forever.

CREATE OR REPLACE FUNCTION public.claim_generation_job(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
    UPDATE public.generation_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        processing_started_at = now(),
        error_message = NULL,
        last_error_code = NULL
    WHERE id = p_job_id
      AND attempts < max_attempts
      AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      AND (
          status IN ('queued', 'failed')
          OR (
              -- Recover a run that stopped without reporting. The five-minute
              -- lease is longer than the generation route's own timeout.
              status = 'processing'
              AND processing_started_at < now() - interval '5 minutes'
          )
      );

    RETURN FOUND;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 4. Record the outcome
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_generation_job(
    p_job_id uuid,
    p_note text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
    UPDATE public.generation_jobs
    SET status = 'completed',
        error_message = p_note,
        last_error_code = NULL,
        next_attempt_at = NULL,
        completed_at = now()
    WHERE id = p_job_id
      AND status <> 'completed';

    RETURN FOUND;
END;
$fn$;

-- Exponential backoff, capped. A job that has used its whole budget becomes
-- 'exhausted' so the rotation is not blocked and an operator can be alerted.
CREATE OR REPLACE FUNCTION public.fail_generation_job(
    p_job_id uuid,
    p_code text,
    p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
    v_job public.generation_jobs;
BEGIN
    UPDATE public.generation_jobs
    SET status = CASE
            WHEN attempts >= max_attempts THEN 'exhausted'
            ELSE 'failed'
        END,
        error_message = left(COALESCE(p_message, p_code), 500),
        last_error_code = left(p_code, 100),
        failed_at = now(),
        next_attempt_at = now()
            + (interval '5 minutes' * power(2, least(attempts, 4))::integer)
    WHERE id = p_job_id
      AND status = 'processing'
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    RETURN jsonb_build_object(
        'updated', true,
        'status', v_job.status,
        'attempts', v_job.attempts,
        'maxAttempts', v_job.max_attempts,
        'nextAttemptAt', v_job.next_attempt_at,
        'exhausted', v_job.status = 'exhausted'
    );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- 5. Read-only rotation status, for the operator and the docs page
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.rotation_status(
    p_now timestamptz DEFAULT now(),
    p_timezone text DEFAULT 'Europe/London'
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
    SELECT jsonb_build_object(
        'timezone', p_timezone,
        'today', (p_now AT TIME ZONE p_timezone)::date,
        'todaysJob', (
            SELECT jsonb_build_object(
                'jobId', j.id,
                'status', j.status,
                'attempts', j.attempts,
                'maxAttempts', j.max_attempts,
                'locationSlug', l.slug
            )
            FROM public.generation_jobs j
            JOIN public.locations l ON l.id = j.location_id
            WHERE j.kind = 'scheduled'
              AND j.scheduled_day_london = (p_now AT TIME ZONE p_timezone)::date
        ),
        'nextUp', (
            SELECT jsonb_build_object('slug', slug, 'name', name)
            FROM public.locations
            WHERE enabled
            ORDER BY last_scheduled_at ASC NULLS FIRST, rotation_order ASC, slug ASC
            LIMIT 1
        ),
        'queue', (
            SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'position'), '[]'::jsonb)
            FROM (
                SELECT jsonb_build_object(
                    'position', lpad(row_number() OVER (
                        ORDER BY last_scheduled_at ASC NULLS FIRST, rotation_order ASC, slug ASC
                    )::text, 3, '0'),
                    'slug', slug,
                    'lastScheduledAt', last_scheduled_at,
                    'lastPublishedAt', last_published_at
                ) AS entry
                FROM public.locations
                WHERE enabled
            ) ranked
        )
    );
$fn$;

-- ---------------------------------------------------------------------------
-- 6. Least-privilege access
-- ---------------------------------------------------------------------------
--
-- Row Level Security is already enabled on every table and no policy grants
-- access, so anon and authenticated can read nothing. The REVOKEs below remove
-- the default table privileges as well, so a future policy cannot accidentally
-- open a table up. All content reaches the public through the server-side API
-- routes, which use the service-role key.

REVOKE ALL ON TABLE public.posts            FROM anon, authenticated;
REVOKE ALL ON TABLE public.locations        FROM anon, authenticated;
REVOKE ALL ON TABLE public.generation_jobs  FROM anon, authenticated;
REVOKE ALL ON TABLE public.content_sources  FROM anon, authenticated;
REVOKE ALL ON TABLE public.activity_log     FROM anon, authenticated;

-- Scheduling and retry functions are operator/server surface only. They are
-- SECURITY DEFINER, so leaving them executable by anon would be a privilege
-- escalation path.
REVOKE ALL ON FUNCTION public.claim_daily_generation_slot(timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_generation_job(uuid)                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_generation_job(uuid, text)            FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_generation_job(uuid, text, text)          FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotation_status(timestamptz, text)             FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_daily_generation_slot(timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_generation_job(uuid)                     TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_generation_job(uuid, text)            TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_generation_job(uuid, text, text)          TO service_role;
GRANT EXECUTE ON FUNCTION public.rotation_status(timestamptz, text)             TO service_role;

COMMIT;
