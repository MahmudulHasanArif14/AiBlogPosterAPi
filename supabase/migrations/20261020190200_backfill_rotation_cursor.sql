-- Seed the rotation cursor from the generation history that already exists.
--
-- Without this, a location that was already given a turn before the cursor
-- column existed would be treated as never scheduled and would jump the queue.
-- Rerunnable: the guard only ever moves a cursor forward.

BEGIN;

UPDATE public.locations AS l
SET last_scheduled_at = history.latest
FROM (
    SELECT location_id, max(scheduled_for) AS latest
    FROM public.generation_jobs
    GROUP BY location_id
) AS history
WHERE l.id = history.location_id
  AND (l.last_scheduled_at IS NULL OR l.last_scheduled_at < history.latest);

UPDATE public.locations AS l
SET last_published_at = history.latest
FROM (
    SELECT location_id, max(published_at) AS latest
    FROM public.posts
    WHERE status = 'published' AND published_at IS NOT NULL
    GROUP BY location_id
) AS history
WHERE l.id = history.location_id
  AND (l.last_published_at IS NULL OR l.last_published_at < history.latest);

COMMIT;
