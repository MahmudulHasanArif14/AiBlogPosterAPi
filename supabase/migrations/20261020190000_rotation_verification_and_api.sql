-- Western Cars central content platform: rotation, verification and API support.
--
-- Additive and rerunnable. It does not drop tables, delete rows, or rewrite
-- existing content. Two indexes and two CHECK constraints are replaced by wider
-- versions; every replacement is recreated inside this same transaction.
--
-- Reviewed for: Europe/London daily slot, fair concurrency-safe location
-- rotation, bounded retries with backoff, publication eligibility enforced in
-- the database, and least-privilege access for the anon/authenticated roles.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Locations: persistent rotation state
-- ---------------------------------------------------------------------------

ALTER TABLE public.locations
    ADD COLUMN IF NOT EXISTS rotation_order integer,
    ADD COLUMN IF NOT EXISTS last_scheduled_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_published_at timestamptz;

COMMENT ON COLUMN public.locations.last_scheduled_at IS
    'Set when this location is given a scheduled generation slot. The daily rotation always picks the enabled location with the oldest value, so the cursor lives in durable state rather than in the application.';

-- Seed the rotation order once, preserving the order the platform launched
-- with. Existing non-null values are left alone so a hand-reordered rotation
-- survives a rerun.
WITH desired(slug, position) AS (
    VALUES
        ('brighton', 1), ('london', 2), ('east-grinstead', 3), ('horley', 4),
        ('crawley', 5), ('horsham', 6), ('lewes', 7), ('haywards-heath', 8),
        ('gatwick', 9), ('worthing', 10), ('reigate', 11), ('lingfield', 12),
        ('falmer', 13)
)
UPDATE public.locations AS l
SET rotation_order = d.position
FROM desired AS d
WHERE l.slug = d.slug
  AND l.rotation_order IS NULL;

-- Any location added later and never ordered sorts after the known ones
-- instead of colliding on NULL.
UPDATE public.locations
SET rotation_order = 1000
WHERE rotation_order IS NULL;

ALTER TABLE public.locations
    ALTER COLUMN rotation_order SET DEFAULT 1000;

CREATE INDEX IF NOT EXISTS locations_rotation_idx
    ON public.locations (last_scheduled_at ASC NULLS FIRST, rotation_order ASC, slug ASC)
    WHERE enabled;

-- ---------------------------------------------------------------------------
-- 2. Generation jobs: scheduled vs manual, London day, bounded retries
-- ---------------------------------------------------------------------------

ALTER TABLE public.generation_jobs
    ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'scheduled',
    ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS failed_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error_code text,
    ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

-- 'scheduled' is the one-per-day cron slot. 'manual' and 'backfill' are
-- operator-initiated and deliberately exempt from the daily unique slot.
ALTER TABLE public.generation_jobs
    DROP CONSTRAINT IF EXISTS generation_jobs_kind_check;

ALTER TABLE public.generation_jobs
    ADD CONSTRAINT generation_jobs_kind_check
    CHECK (kind IN ('scheduled', 'manual', 'backfill'));

-- 'exhausted' is terminal: reached after max_attempts, so a permanently broken
-- job stops consuming retries and can be alerted on instead.
ALTER TABLE public.generation_jobs
    DROP CONSTRAINT IF EXISTS generation_jobs_status_check;

ALTER TABLE public.generation_jobs
    ADD CONSTRAINT generation_jobs_status_check
    CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'exhausted'));

ALTER TABLE public.generation_jobs
    DROP CONSTRAINT IF EXISTS generation_jobs_max_attempts_check;

ALTER TABLE public.generation_jobs
    ADD CONSTRAINT generation_jobs_max_attempts_check
    CHECK (max_attempts BETWEEN 1 AND 10);

-- The platform's own timezone, not UTC, defines "one article per day".
-- timezone(text, timestamptz) is IMMUTABLE, so this is valid in a stored
-- generated column; a 23- or 25-hour BST transition day is still one date.
ALTER TABLE public.generation_jobs
    ADD COLUMN IF NOT EXISTS scheduled_day_london date
    GENERATED ALWAYS AS ((scheduled_for AT TIME ZONE 'Europe/London')::date) STORED;

-- The old index made the daily slot global, which blocked operator-initiated
-- backfills entirely. Scope it to the scheduled kind and the London day.
DROP INDEX IF EXISTS public.generation_jobs_one_per_utc_day;

CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_one_scheduled_per_london_day
    ON public.generation_jobs (scheduled_day_london)
    WHERE kind = 'scheduled';

CREATE INDEX IF NOT EXISTS generation_jobs_retry_idx
    ON public.generation_jobs (status, next_attempt_at ASC NULLS FIRST, scheduled_for ASC)
    WHERE status IN ('queued', 'failed', 'processing');

CREATE INDEX IF NOT EXISTS generation_jobs_location_idx
    ON public.generation_jobs (location_id, scheduled_for DESC);

-- ---------------------------------------------------------------------------
-- 3. Posts: API fields, duplicate guards, verification record
-- ---------------------------------------------------------------------------

ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS author text,
    ADD COLUMN IF NOT EXISTS category text,
    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS reading_minutes integer,
    ADD COLUMN IF NOT EXISTS quality_score integer,
    ADD COLUMN IF NOT EXISTS quality_reasons text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'unverified',
    ADD COLUMN IF NOT EXISTS verified_claims jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS source_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS content_hash text,
    ADD COLUMN IF NOT EXISTS review_notes text;

COMMENT ON COLUMN public.posts.verification_status IS
    'verified means every material claim the generator declared was matched to an approved content_sources row whose URL responded successfully at generation time. It records that provenance check, not proof of truth.';

COMMENT ON COLUMN public.posts.review_notes IS
    'Internal reviewer notes. Never returned by the public API.';

ALTER TABLE public.posts
    DROP CONSTRAINT IF EXISTS posts_verification_status_check;

ALTER TABLE public.posts
    ADD CONSTRAINT posts_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'failed'));

-- Normalised title for duplicate detection, matching the application's
-- normaliser: lowercase, non-alphanumerics collapsed to single spaces.
ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS title_normalized text
    GENERATED ALWAYS AS (
        btrim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))
    ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS posts_unique_title_normalized
    ON public.posts (title_normalized);

CREATE UNIQUE INDEX IF NOT EXISTS posts_unique_content_hash
    ON public.posts (content_hash)
    WHERE content_hash IS NOT NULL;

-- Stable, tie-broken ordering for the paginated public API.
CREATE INDEX IF NOT EXISTS posts_published_feed_idx
    ON public.posts (published_at DESC, id DESC)
    WHERE status = 'published';

CREATE INDEX IF NOT EXISTS posts_location_published_feed_idx
    ON public.posts (location_id, published_at DESC, id DESC)
    WHERE status = 'published';

CREATE INDEX IF NOT EXISTS posts_location_status_idx
    ON public.posts (location_id, status);

-- A published row must carry everything the public API and the consuming
-- websites need. This is the last line of defence behind the quality gate.
ALTER TABLE public.posts
    DROP CONSTRAINT IF EXISTS posts_published_requires_metadata;

ALTER TABLE public.posts
    ADD CONSTRAINT posts_published_requires_metadata
    CHECK (
        status <> 'published'
        OR (
            published_at IS NOT NULL
            AND canonical_url IS NOT NULL
            AND length(btrim(title)) >= 20
            AND length(btrim(excerpt)) >= 50
            AND length(btrim(content)) >= 1200
            AND length(btrim(meta_description)) >= 70
        )
    );

CREATE OR REPLACE FUNCTION public.posts_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS posts_set_updated_at ON public.posts;

CREATE TRIGGER posts_set_updated_at
    BEFORE UPDATE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.posts_set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Publication eligibility, enforced in the database
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.posts_enforce_publication_eligibility()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
    IF NEW.status <> 'published' THEN
        RETURN NEW;
    END IF;

    -- A failed provenance check can never reach the published state, whatever
    -- the caller asks for.
    IF NEW.verification_status = 'failed' THEN
        RAISE EXCEPTION 'publication_blocked: verification_status is failed'
            USING ERRCODE = 'check_violation';
    END IF;

    IF COALESCE(array_length(NEW.quality_reasons, 1), 0) > 0 THEN
        RAISE EXCEPTION 'publication_blocked: unresolved quality reasons (%)',
            array_to_string(NEW.quality_reasons, ',')
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.quality_score IS NULL OR NEW.quality_score < 85 THEN
        RAISE EXCEPTION 'publication_blocked: quality_score % is below 85',
            COALESCE(NEW.quality_score, -1)
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS posts_enforce_publication_eligibility ON public.posts;

CREATE TRIGGER posts_enforce_publication_eligibility
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.posts_enforce_publication_eligibility();

-- Keep the location's published cursor in step so operators can see coverage
-- gaps without scanning every post.
CREATE OR REPLACE FUNCTION public.posts_touch_location_published()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $fn$
BEGIN
    IF NEW.status = 'published' AND NEW.published_at IS NOT NULL THEN
        UPDATE public.locations
        SET last_published_at = GREATEST(COALESCE(last_published_at, NEW.published_at), NEW.published_at)
        WHERE id = NEW.location_id;
    END IF;

    RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS posts_touch_location_published ON public.posts;

CREATE TRIGGER posts_touch_location_published
    AFTER INSERT OR UPDATE OF status, published_at ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.posts_touch_location_published();

COMMIT;
