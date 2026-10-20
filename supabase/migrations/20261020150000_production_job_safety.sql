-- Production safeguards for daily scheduling and retry-safe article generation.
-- Apply only after reviewing and testing the application changes.

ALTER TABLE public.generation_jobs
    ADD COLUMN IF NOT EXISTS scheduled_day_utc date
    GENERATED ALWAYS AS (
        (scheduled_for AT TIME ZONE 'UTC')::date
    ) STORED;

-- The database, not the application check, enforces one scheduled job per UTC day.
CREATE UNIQUE INDEX IF NOT EXISTS generation_jobs_one_per_utc_day
    ON public.generation_jobs (scheduled_day_utc);

-- Associate an article with its originating job so retries cannot create
-- a second article for the same job.
ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS job_id uuid
    REFERENCES public.generation_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS posts_one_article_per_job
    ON public.posts (job_id)
    WHERE job_id IS NOT NULL;

-- Supports recovery if a generation request stops while processing.
ALTER TABLE public.generation_jobs
    ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

-- Atomically claim a queued/failed job or recover an abandoned processing job.
-- A five-minute lease prevents a second request taking over a live generation.
CREATE OR REPLACE FUNCTION public.claim_generation_job(p_job_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
    claimed boolean;
BEGIN
    UPDATE public.generation_jobs
    SET status = 'processing',
        attempts = attempts + 1,
        processing_started_at = now(),
        error_message = NULL
    WHERE id = p_job_id
      AND (
          status IN ('queued', 'failed')
          OR (
              status = 'processing'
              AND processing_started_at < now() - interval '5 minutes'
          )
      );

    claimed := FOUND;
    RETURN claimed;
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_generation_job(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_generation_job(uuid) TO service_role;