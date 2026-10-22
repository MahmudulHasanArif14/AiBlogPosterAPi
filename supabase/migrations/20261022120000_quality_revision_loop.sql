-- Automatic quality improvement loop: persisted revision state.
--
-- Additive and rerunnable. It adds columns and one function; it drops nothing,
-- rewrites no content, and changes no existing row's status.
--
-- Prerequisite: 20261020190000_rotation_verification_and_api.sql, which widens
-- generation_jobs_status_check to allow 'exhausted'. abandon_generation_job
-- below writes that status, so without it every call raises a check violation.
--
-- Rollback: dropping the six columns and the function is enough, and leaves no
-- orphaned state -- but it discards every stored draft, so any article still in
-- revision would restart from nothing. The application code requires these
-- columns, so revert the code first.
--
-- Why these columns: a revision cycle is bounded by time, so a draft that has
-- not passed yet has to survive the end of the process and be picked up by the
-- next cycle. Without the stored draft the only way to resume would be to
-- generate a new article, which would consume another rotation turn for work
-- that was already done.

BEGIN;

ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS revision_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS provider_retry_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS best_quality_score integer,
    ADD COLUMN IF NOT EXISTS best_draft jsonb,
    ADD COLUMN IF NOT EXISTS latest_draft jsonb,
    ADD COLUMN IF NOT EXISTS last_revision_at timestamptz;

COMMENT ON COLUMN public.posts.best_draft IS
    'The best-known draft of this article, in the generator''s article schema. A later cycle resumes from this rather than generating a new article, so a revision never consumes a second rotation turn.';

COMMENT ON COLUMN public.posts.latest_draft IS
    'The most recent revision, retained for diagnosis when it scored worse than best_draft. NULL when the latest revision is the best one.';

COMMENT ON COLUMN public.posts.revision_count IS
    'Content revisions applied to this article across all cycles. Counted separately from provider_retry_count: a revision means the article was wrong, a provider retry means the call was.';

ALTER TABLE public.posts
    DROP CONSTRAINT IF EXISTS posts_revision_counts_non_negative;

ALTER TABLE public.posts
    ADD CONSTRAINT posts_revision_counts_non_negative
    CHECK (revision_count >= 0 AND provider_retry_count >= 0);

-- Finding the drafts a cycle could resume, without scanning published content.
CREATE INDEX IF NOT EXISTS posts_resumable_drafts_idx
    ON public.posts (created_at ASC)
    WHERE status = 'needs_review' AND best_draft IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Terminal state for a job that cannot recover
-- ---------------------------------------------------------------------------
--
-- fail_generation_job only reaches 'exhausted' by running the attempt budget
-- down. A permanent provider error, or a draft that has aged past the revision
-- window, is known to be unrecoverable now, and leaving it in 'failed' would
-- hold its location's rotation turn for every remaining attempt.

CREATE OR REPLACE FUNCTION public.abandon_generation_job(
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
    SET status = 'exhausted',
        error_message = left(COALESCE(p_message, p_code), 500),
        last_error_code = left(p_code, 100),
        failed_at = now(),
        next_attempt_at = NULL
    WHERE id = p_job_id
      AND status <> 'completed'
    RETURNING * INTO v_job;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    RETURN jsonb_build_object(
        'updated', true,
        'status', v_job.status,
        'attempts', v_job.attempts,
        'maxAttempts', v_job.max_attempts
    );
END;
$fn$;

REVOKE ALL ON FUNCTION public.abandon_generation_job(uuid, text, text)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.abandon_generation_job(uuid, text, text)
    TO service_role;

COMMIT;
