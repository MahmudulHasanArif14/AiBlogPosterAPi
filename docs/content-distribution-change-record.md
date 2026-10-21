# Change record: automatic blog distribution

Context for [#5](https://github.com/MahmudulHasanArif14/AiBlogPosterAPi/pull/5)
(`feat/content-distribution`, merged 2026-10-21), written at the time the work
was done. The PR itself was merged with an auto-generated description, so this
is where the reasoning lives.

For how to *operate* the system, see [content-distribution.md](./content-distribution.md).
This file records why it is built the way it is and what was outstanding at merge.

---

This change delivers published articles from this platform to the location websites, and adds the scheduled task that makes delivery reliable rather than best-effort.

## What this adds

- **`content_deliveries`** — a durable outbox in Postgres, plus five functions: `enqueue_content_delivery`, `claim_content_deliveries`, `mark_delivery_result`, `reconcile_content_deliveries`, `delivery_health`.
- **Signed webhook delivery** — HMAC-SHA256 over `v1:<timestamp>:<raw body>`, compared in constant time. The webhook carries identifiers only, never article text.
- **`/api/cron/deliver`** — reconciles, then dispatches, then reports health. Idempotent, so running it twice is harmless.
- **`/api/admin/deliveries`** — queue state, per-location endpoint configuration (origin and `hasSecret`, never the secret), and a way to reopen a dead delivery.
- **Scheduling, declared twice** — `vercel.json` on `*/10 * * * *`, and a GitHub Actions workflow that does the same. See the caveat below.

## What guarantees what

| Concern | Mechanism |
| --- | --- |
| Drafts are never distributed | `enqueue_content_delivery` refuses any post not `published`, and `claim_content_deliveries` re-checks at dispatch time |
| An article is announced once | Unique index on `(post_id, event)` |
| Two scheduler runs don't double-send | `FOR UPDATE SKIP LOCKED` plus a lease longer than one attempt |
| A missed webhook is recovered | `reconcile_content_deliveries` is an **anti-join, not a cursor** — a failed request cannot advance past an article |
| Replay | The timestamp is inside the signed string, with a ±5 minute window |
| A failing receiver doesn't block others | `Promise.allSettled`, per-row backoff, dead-lettering after 8 attempts |

## Two properties worth stating plainly

**Nothing here can publish an article.** Publication is decided by the existing quality gate and, where overridden, by a recorded human review. Distribution only ever reacts to a publication that already happened. The quality gate is untouched by this work.

**Enqueue failure cannot break publication.** `enqueueDelivery` never throws — it handles an RPC error, a `post_not_published` refusal, and a thrown exception. Verified by line number on both publish paths (`src/lib/generation.ts`, `src/app/api/admin/review/route.ts`).

## Database migration — already applied

`supabase/migrations/20261021120000_content_delivery_queue.sql` was applied to production on 2026-10-21 and verified. Local and remote migration history are aligned. It created only new objects — no existing table was altered and no existing row was modified.

Post-apply verification: function `EXECUTE` is false for `anon` and `authenticated` and true for `service_role` on all five (15/15 checks); the table grants the same way; RLS is enabled with zero policies; all five indexes exist; and all three read-only function bodies execute without a plpgsql error.

Commit `81f23e1` fixed a real hole found in review: the function `REVOKE`s named only `anon, authenticated`. Postgres grants `EXECUTE` to `PUBLIC` on every new function, and revoking from `anon` does not remove a privilege `anon` holds *through* `PUBLIC` — so all five would have been callable with the anon key via `/rest/v1/rpc/<name>`, three of which mutate the queue.

## Tests

72 tests pass; type-check and lint are clean. Coverage includes published vs unpublished, signature failures, replay protection, retries, idempotency, missed webhooks, pagination, location isolation and API failures.

## Outstanding at merge, before anything is actually delivered

1. Brighton's confirmed production domain — **unresolved as of this merge**, and it gates the rest. Canonical URLs and the sitemap on the Brighton site are wrong until it is settled.
2. `DELIVERY_WEBHOOK_URL_BRIGHTON` and `DELIVERY_WEBHOOK_SECRET_BRIGHTON` on Vercel, server-only. Neither may take a `NEXT_PUBLIC_` prefix. **Not set at merge** — which is why nothing is being sent yet.
3. `CONTENT_API_ORIGIN` (variable) and `CRON_SECRET` (secret) on this repository, for the workflow. Both **verified present** on 2026-10-21, so the scheduled pass runs as soon as the workflow is on the default branch.

Until item 2 is done the scheduler is harmless: it finds published articles, enqueues them, and parks them. A location with no URL/secret pair is skipped quietly.

A location with no URL/secret pair is skipped quietly — the correct state for the twelve locations with no website yet.

## Caveat on the scheduler

**On Vercel's Hobby plan a cron runs at most once per day**, so `vercel.json` only meets the 5–15 minute requirement once the project is on Pro. The GitHub Actions workflow is what actually runs — but scheduled workflows only fire from the default branch, so **it will not run until this merges**. GitHub's schedules are also best-effort; that is tolerable here because the reconciler re-derives outstanding work from the database on every pass, so a late run delays a notification rather than losing one.

> On discovery: the sitemap, internal links and a valid feed make these pages discoverable. None of them, and no amount of revalidation, guarantees that Google indexes a page or how it ranks.
