-- Make source_url usable as an ON CONFLICT target.
--
-- 20261020190100 created a *partial* unique index on content_sources
-- (source_url) WHERE source_url IS NOT NULL. Postgres cannot infer an
-- ON CONFLICT target from a partial index unless the statement repeats the
-- index predicate, so the idempotent upsert in /api/admin/sources failed with
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification".
--
-- A plain UNIQUE constraint is the right tool and loses nothing: the SQL
-- standard treats NULLs as distinct, so several rows may still have no URL.

BEGIN;

DROP INDEX IF EXISTS public.content_sources_unique_url;

DO $$
BEGIN
    ALTER TABLE public.content_sources
        ADD CONSTRAINT content_sources_source_url_key UNIQUE (source_url);
EXCEPTION
    WHEN duplicate_table THEN NULL;  -- constraint already present
    WHEN duplicate_object THEN NULL;
END;
$$;

COMMIT;
