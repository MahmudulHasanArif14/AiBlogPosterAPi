# Western Cars Central AI Blog Platform

One central Next.js + Supabase + OpenRouter content platform. It generates one
article per day, rotating through the Western Cars locations, puts every article
through a quality and provenance gate, and serves the published ones to each
location's own website through a read-only HTTP API.

Production: <https://content.westerncars.com> · API docs: `/api-docs`

## How it fits together

```
Vercel cron (daily, UTC trigger)
  └─ GET /api/cron                  claims the London-day slot, then generates
       ├─ claim_daily_generation_slot()   picks the next location, atomically
       ├─ claim_generation_job()          leases the job for this run
       ├─ OpenRouter                      writes the article
       ├─ quality gate + provenance check decides publish vs. review
       └─ posts row                       published only if everything passes

Consuming websites (westerncarsbrighton.co.uk, …)
  └─ GET /api/posts?location=brighton&page=1&limit=10
     GET /api/posts/{slug}
       └─ rendered as native pages on their own domain
```

## Public API

Read-only, no authentication, no API key.

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/api/posts` | Paginated published articles. `location`, `page`, `limit` (max 50), `content=summary\|full`. |
| GET | `/api/posts/{slug}` | One published article with its full body. |
| GET | `/api/locations` | Enabled location slugs and published counts. |
| GET | `/feed.xml` | RSS 2.0, optional `?location=`. |
| GET | `/sitemap.xml` | This hub's own article URLs only. |

`/api-docs` is the full reference: parameters, every response field, error codes,
caching, and copy-pasteable Next.js integration for a consuming site.

### Protected routes

All require `Authorization: Bearer $CRON_SECRET`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/cron` | The daily scheduled run. Vercel supplies the bearer token. |
| GET | `/api/status` | Rotation state, recent jobs, article counts by status. |
| POST | `/api/generate` | Run one existing job by id. |
| POST | `/api/admin/jobs` | Create and optionally run a `manual` job for one location. |
| GET/POST | `/api/admin/sources` | Read, or re-verify and sync, the approved source list. |

## One article per day, and fair rotation

"One per day" is platform-wide, not per location.

The rotation cursor is `locations.last_scheduled_at`. `claim_daily_generation_slot()`
picks the enabled location with the oldest value, so a location cannot get a
second turn until every other enabled location has had one, and a newly enabled
location goes to the front of the queue.

Concurrency safety has three layers:

1. `FOR UPDATE` on the chosen `locations` row serialises rotation advancement.
2. A partial unique index on `generation_jobs (scheduled_day_london) WHERE kind = 'scheduled'`
   makes a second slot for the same London day impossible.
3. The `unique_violation` handler turns that race into "reuse the slot the other
   invocation created" rather than an error.

`kind = 'manual'` and `kind = 'backfill'` jobs are exempt from the daily unique
index, so operator-initiated backfills never consume or disturb the cron slot.

### Timezone and daylight saving

Vercel triggers crons on a **UTC** schedule, so `vercel.json` carries a UTC
trigger while the *slot* is keyed on the `Europe/London` calendar date, computed
in Postgres via a stored generated column. A 03:00 UTC trigger is 03:00 GMT or
04:00 BST — both comfortably inside the same London day — so a BST transition
can neither produce two slots for one London day nor skip one.

### Retries

Jobs carry `attempts`, `max_attempts` (3) and `next_attempt_at`. `fail_generation_job()`
applies exponential backoff capped at 80 minutes and moves a job to the terminal
`exhausted` state once the budget is spent, so a permanently broken job stops
consuming retries and becomes visible in `/api/status` instead of blocking the
rotation. `claim_generation_job()` also recovers a job whose run died without
reporting, after a five-minute lease.

The cron finishes an unfinished earlier job before claiming a new slot, so a
location that failed keeps its turn rather than being skipped.

## Quality and publication control

An article is published only if **every** check passes *and*
`AUTO_PUBLISH_ENABLED=true`. Otherwise it is stored as `needs_review` with its
reasons recorded in `quality_reasons` and `review_notes`.

Structural: required fields, 450–2600 words, four or more paragraphs, no HTML,
meta description 70–160 characters, excerpt distinct from the title.

Duplication: exact normalised title, exact slug, and near-duplicate bodies via
Jaccard similarity over word trigrams (blocking at 0.6, warning at 0.45).

Integrity: placeholder residue (`TODO`, template tokens, model self-reference),
promotional overreach (cheapest, guaranteed fare, never late, award-winning,
testimonials), keyword stuffing, and citations to any domain that is not an
approved source or an official `gov.uk` / `ac.uk` / `nhs.uk` host.

Local accuracy: every `X Station` / `X Airport` / `X Port` mention is checked
against a list of real transport places in `src/lib/places.ts`. An invented
station is the most damaging kind of local error, because it reads as
authoritative.

Provenance: the generator must declare every material claim — money, clock
times, durations, distances, percentages, capacities, opening hours, platform
numbers, licensing and accessibility credentials — with a source URL from the
approved list. `src/lib/verification.ts` then checks each declared URL still
resolves. A 404 or an unapproved domain fails the article outright.

The database is the final gate, not the application. A `BEFORE INSERT OR UPDATE`
trigger on `posts` refuses the `published` status when `verification_status` is
`failed`, when `quality_reasons` is non-empty, or when `quality_score` is below
85. A `CHECK` constraint additionally requires a published row to carry
`published_at`, `canonical_url` and non-trivial title, excerpt, body and meta
description. Nothing can bypass publication control by writing to the table
directly.

### What "verified" does and does not mean

`verification_status = 'verified'` means every material claim the generator
declared was matched to an operator-approved source whose URL still resolved at
generation time, and those URLs are stored with the article and shown to
readers.

That is **traceability, not truth**. The checks do not read the source page or
confirm it supports the claim. A passing quality gate and a successful model
response are not evidence of factual accuracy. Fares, timetables and service
details change. Anything the gate cannot place goes to human review rather than
being published.

## Security

- The service-role key is read in `src/lib/supabase.ts` only and never reaches
  the browser. No client component touches Supabase.
- RLS is enabled on every table with no policy granting access, and table
  privileges are revoked from `anon` and `authenticated`, so those roles can
  read nothing even if a policy is added later by mistake. All content reaches
  the public through server-side route handlers.
- Scheduling functions are `SECURITY DEFINER` with `search_path = ''` and
  `EXECUTE` granted only to `service_role`.
- The public API returns published articles only. Quality scores, failure
  reasons, reviewer notes, verification records, internal prompts and drafts are
  never serialised — see `PUBLIC_COLUMNS` in `src/lib/posts-repository.ts`.
- A draft, a review-held article and a slug that never existed are
  indistinguishable from outside: all return `404 post_not_found`.
- `CRON_SECRET` authenticates the cron trigger and the admin routes. It is not a
  staff login and must not be used as one.

## Node version

The worker needs **Node 22 or newer**. `@supabase/supabase-js` builds a
RealtimeClient when the client is constructed and throws on a runtime with no
global `WebSocket`, which Node 20 does not have. The GitHub Actions workflow
pins 22; Vercel runs 24.

## Hosting constraints

This project is on Vercel's **Hobby** plan, which caps a function at 60 seconds
and allows one cron invocation per day.

Generation measured against the configured reasoning model takes **60-115
seconds**, so it cannot run in a Vercel function at all. The daily run is a
plain Node worker, `scripts/generate.ts`, driven by
`.github/workflows/daily-article.yml`, where there is no time limit.
`vercel.json` carries an empty `crons` array so the two schedulers cannot both
fire.

The Vercel routes still share the same `runGenerationJob()` pipeline and remain
useful for short operator work, but anything that needs a full article should go
through the workflow.

### Running the workflow by hand

Actions → **Daily article** → Run workflow, then pick a mode:

| Mode | What it does |
| --- | --- |
| `daily` | Takes the next rotation slot. What the schedule runs. |
| `seed` | Generates the five-article initial batch, skipping any location that already has a published article. Safe to re-run. |
| `location` | Generates one article for the `location` slug you give it, with an optional `topic`. Creates a `manual` job, so the daily slot is untouched. |

The Supabase project is in `ap-northeast-1` while the Vercel functions run in
`iad1`, so every database round trip carries real latency. Queries that can run
together do, via `Promise.all`.

## Setup

1. Install Node.js LTS and Git, then `npm install`.
2. Create a Supabase project and apply the migrations:
   `npx supabase link --project-ref YOUR_REF && npx supabase db push`.
3. Copy `.env.example` to `.env.local` and fill it in.
4. Seed the approved sources — nothing can be published until this is done,
   because a claim with no approved source cannot be traced:
   ```
   curl -X POST https://your-host/api/admin/sources -H "Authorization: Bearer $CRON_SECRET"
   ```
5. `npm run dev`, then check `/api-docs`.

## Checks

```
npm run verify      # lint, type-check and tests
npm run lint
npm run type-check
npm test            # quality gate, places, citations, similarity
npm run build
```

`npm run build` writes to `.next`. To build while `next dev` is running — which
holds `.next` open on Windows — set `NEXT_DIST_DIR=.next-verify`.

Generation from a terminal (needs Node 22+ and the env in `.env.example`):

```
npm run generate:daily                       # take the next rotation slot
npm run generate:one -- --seed               # the five-article initial batch
npm run generate:one -- --location brighton  # one article for one location
```

## Operating it

Check the rotation and job health:

```
curl -s https://content.westerncars.com/api/status \
  -H "Authorization: Bearer $CRON_SECRET" | jq '.rotation.nextUp, .posts.byStatus'
```

Backfill one location without touching the daily slot:

```
curl -X POST https://content.westerncars.com/api/admin/jobs \
  -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"locationSlug":"brighton"}'
```

Re-verify the approved sources after a council or operator moves a page:

```
curl -X POST https://content.westerncars.com/api/admin/sources \
  -H "Authorization: Bearer $CRON_SECRET" | jq '.approved, .rejected'
```

## Not implemented

- No staff dashboard or Supabase Auth roles. Review happens in the Supabase
  table editor, and `/api/admin/*` is protected by a shared secret rather than
  per-user authorisation.
- No failure alerting beyond `activity_log` and the `exhausted` job state.
  Nothing emails or pages anyone.
- `verification` checks that a source resolves, not that it supports the claim.
  Semantic claim-to-source checking is not implemented.
- `postcss` and `sharp` carry published advisories reachable only through
  `next`'s own dependency tree. Clearing them needs a Next 16 major upgrade,
  which has not been done here.
