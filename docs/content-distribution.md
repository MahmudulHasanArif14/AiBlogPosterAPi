# Content distribution

How a published article reaches a location website, and what has to be
configured for that to work.

## The path an article takes

```
            generation (GitHub Actions, daily)
                        |
                 quality + provenance gate
                        |
            status = 'published'  (or held for review)
                        |
         enqueue_content_delivery(post, 'published')      <- SQL refuses
                        |                                     anything not
              content_deliveries  (durable outbox)            published
                        |
    scheduled pass, every 10 minutes:  /api/cron/deliver
         1. reconcile: published articles with no delivery row
         2. dispatch: claim due rows, send signed POST
                        |
      POST https://<site>/api/revalidate-blog   (HMAC-SHA256 signed)
                        |
      site revalidates: blog listing, the article, RSS, sitemap
                        |
      site's pages fetch the article from /api/posts  (public, published only)
```

Two properties worth stating plainly:

- **The webhook carries no article text.** It carries identifiers. The website
  fetches the article from the public API, so a website can never render a
  version of an article the API would not also serve, and a captured webhook
  leaks nothing.
- **Nothing here can publish an article.** Publication is decided by the
  quality gate and, where overridden, by a recorded human review. Distribution
  only ever reacts to a publication that already happened.

## What guarantees what

| Concern | What actually provides it |
| --- | --- |
| Drafts are never distributed | `enqueue_content_delivery` checks `status = 'published'` in SQL, and `claim_content_deliveries` re-checks at dispatch time |
| An article is announced once | Unique index on `content_deliveries (post_id, event)` |
| Two scheduler runs don't double-send | `FOR UPDATE SKIP LOCKED` plus a lease longer than one attempt |
| A missed webhook is recovered | `reconcile_content_deliveries`: an anti-join, not a cursor, so a failed request cannot advance past an article |
| Request authenticity | HMAC-SHA256 over `v1:<timestamp>:<body>`, compared in constant time |
| Replay | The timestamp is inside the signed string, with a ±5 minute window |
| Another location's article on this domain | Location checked in the request, on the receiver, and again on every article rendered |
| A failing receiver doesn't block others | `Promise.allSettled`, per-row backoff, dead-lettering after 8 attempts |

## Environment variables

### Central platform (this repo), Vercel project settings

All server-only. None of these may be given a `NEXT_PUBLIC_` prefix.

| Variable | Value | Notes |
| --- | --- | --- |
| `DELIVERY_WEBHOOK_URL_BRIGHTON` | `https://<brighton domain>/api/revalidate-blog` | One per location, suffix = slug uppercased, hyphens to underscores |
| `DELIVERY_WEBHOOK_SECRET_BRIGHTON` | `openssl rand -hex 32` | Must match the website's `REVALIDATE_WEBHOOK_SECRET` byte for byte |
| `CRON_SECRET` | already set | Also authenticates `/api/cron/deliver` |
| `SITE_URL` | already set | Used to build the `contentUrl` in the payload |

Optional: `DELIVERY_TIMEOUT_MS` (8000), `DELIVERY_BATCH_SIZE` (10),
`RECONCILE_WINDOW_HOURS` (48), `RECONCILE_BATCH_SIZE` (25).

A location with no URL/secret pair is skipped quietly. That is the correct
state for the twelve locations that have no website yet.

### GitHub repository (this repo), for the scheduled fallback

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `CONTENT_API_ORIGIN` | the deployed platform origin, e.g. `https://content.westerncars.com` |
| Secret | `CRON_SECRET` | same value as the Vercel env var |

### Location website (e.g. BrightonTaxis), Vercel project settings

| Variable | Scope | Value |
| --- | --- | --- |
| `REVALIDATE_WEBHOOK_SECRET` | server-only | same as `DELIVERY_WEBHOOK_SECRET_BRIGHTON` |
| `CONTENT_API_ORIGIN` | server-only | the platform origin |
| `NEXT_PUBLIC_SITE_URL` | public | that site's own public origin, no trailing slash |
| `NEXT_PUBLIC_CONTENT_LOCATION` | public | `brighton` |

## Scheduling

The task must run every 5-15 minutes. It is declared twice:

- `vercel.json` declares `/api/cron/deliver` on `*/10 * * * *`. **On Vercel's
  Hobby plan a cron runs at most once per day**, so this only takes effect once
  the project is on Pro.
- `.github/workflows/deliver-content.yml` calls the same endpoint every ten
  minutes. This is what actually runs today.

Both hit the same idempotent endpoint, so running under both is harmless. When
the project moves to Pro, the workflow can be deleted or left in place.

GitHub's scheduled triggers are best-effort and can be delayed. That is
tolerable here because the reconciler re-derives outstanding work from the
database on every pass rather than advancing a cursor: a late run delays a
notification, it does not lose one.

## Operating it

```bash
# Queue state, per-location endpoint configuration, last 50 deliveries
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<platform>/api/admin/deliveries

# Run a delivery pass by hand
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<platform>/api/cron/deliver

# Reopen a delivery that gave up (e.g. the site was down for a weekend)
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"deliveryId":"<uuid>","extraAttempts":3}' \
  https://<platform>/api/admin/deliveries
```

`published_without_delivery` in the health block should be `0`. A number that
stays non-zero means the reconciler is not getting through. A non-zero
`recovered` count in the scheduled pass means articles are publishing but the
immediate enqueue is failing — the articles still arrive, but the publish path
is worth investigating.

## Adding the next location website

1. Build the site with the four files the Brighton site uses:
   `src/lib/site.ts`, `src/lib/content-api.ts`, `src/lib/webhook-signature.ts`
   and `src/app/api/revalidate-blog/route.ts`. Only `site.ts` needs editing —
   the location slug and the origin.
2. Generate a secret: `openssl rand -hex 32`.
3. Set the four variables on the new site, and the two
   `DELIVERY_WEBHOOK_*_<SLUG>` variables on the platform.
4. Nothing else. No migration, no code change on the platform, no deployment of
   the platform at all.

The first scheduled pass after the variables are set will reconcile that
location's already-published articles and deliver them, because they have no
delivery rows yet.

> Note on indexing: the sitemap, internal links and a valid feed are what make
> these pages *discoverable*. None of them, and no amount of revalidation,
> guarantees that Google indexes a page or how it ranks.
