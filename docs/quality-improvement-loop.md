# Automatic quality improvement loop

An AI-generated article that fails the quality checks is no longer written off
to review and forgotten. It is sent back to the provider with the exact checks
it failed, re-evaluated by the same evaluator, and improved repeatedly until it
passes or a bound is reached.

Nothing in the loop decides whether an article is good. `checkQuality`,
`verifySources` and the image lookup decide that, and the loop only reacts to
their verdict. The model is never asked for a score and is never believed about
one.

## Where it lives

| File | Role |
| --- | --- |
| `src/lib/revision.ts` | The loop state machine, draft ranking, correction instructions, backoff. No I/O. |
| `src/lib/generation.ts` | Supplies the provider adapter, the evaluator and persistence; owns the resume decision. |
| `src/lib/config.ts` | The validated configuration. |
| `supabase/migrations/20261022120000_quality_revision_loop.sql` | Persisted revision state and the terminal-job function. |
| `tests/revision.test.ts` | The loop's contract. |

## Pass and fail

An article is eligible for publication only when **both** hold:

1. `quality_score >= MIN_ARTICLE_QUALITY_SCORE`, and
2. every mandatory gate passes — the quality gate's own reasons, source
   verification (`verification_status = 'verified'`), and a licensed featured
   image (`image_not_verified`).

A high score never carries a failed verification. The database enforces the same
rule independently: `posts_enforce_publication_eligibility` rejects a published
row whose `quality_reasons` are non-empty, whose `verification_status` is
`failed`, or whose score is below 85.

Reaching a retry limit is never a reason to publish. Only a passing evaluation
moves an article out of `needs_review`.

## State machine

One **cycle** is one claimed job attempt. Within a cycle:

```
          ┌──────────────────────────────────────────┐
          │ generate initial draft, or resume the    │
          │ stored best-known draft (no new rotation)│
          └───────────────────┬──────────────────────┘
                              ▼
                        ┌───────────┐
                        │ evaluate  │◄─────────────────┐
                        └─────┬─────┘                  │
                   pass ◄─────┴─────► fail             │
                     │                 │               │
                     ▼                 ▼               │
              outcome: passed   revisions left and      │
              → publish or      budget left?            │
                hold for        ├─ yes → revise draft ──┘
                approval        │        (failed checks + evidence)
                                └─ no  → outcome: retry_later
```

Exits:

| Outcome | Job status | Article status |
| --- | --- | --- |
| `passed` | `completed` | `published` if `AUTO_PUBLISH_ENABLED=true`, else `needs_review` |
| `retry_later` | `failed` with exponential backoff, or `exhausted` once the attempt budget is spent | `needs_review`, best draft stored |
| `terminal` | `exhausted` (via `abandon_generation_job`) | `needs_review` if a draft exists |
| `no_draft` | `failed` | none |

Two budgets are tracked separately, because a 429 is not a bad article:

- **content revisions** — the article was wrong;
- **provider retries** — the call was wrong (rate limit, timeout, 5xx,
  truncated or unparseable output).

Permanent provider errors (rejected request, bad credentials, unknown model) are
not retried at all.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `MIN_ARTICLE_QUALITY_SCORE` | `85` | Setting it below 85 loosens nothing: the database floor still applies. |
| `MAX_QUALITY_REVISIONS` | `5` | Content revisions per cycle. |
| `MAX_PROVIDER_RETRIES` | `3` | Provider retries per cycle. |
| `QUALITY_CYCLE_BUDGET_MS` | `900000` | Wall-clock budget for one cycle. The Vercel routes pass 50 s instead, since one provider call alone costs 60–115 s. |
| `MAX_ARTICLE_REVISION_AGE_HOURS` | `72` | After this, the draft stops being retried and waits for a person. |

Every value is validated at module load; a non-integer or out-of-range value
throws rather than silently falling back.

The overall retry budget across cycles is the job's own `max_attempts`
(default 3), so the worst case is `max_attempts × MAX_QUALITY_REVISIONS`
revisions before the job becomes `exhausted`.

## Resuming, and the rotation

A revision never consumes a second daily rotation turn. The draft and its
failure details live on the article the job already owns
(`posts.best_draft`), and a later cycle resumes *that* job:

- `scripts/generate.ts --daily` first resumes any pending revision, then claims
  today's own slot, so a draft still in revision does not stop the platform
  publishing anything new;
- `claim_daily_generation_slot` is keyed on the London day, so the resumed job
  and today's slot can never be the same work twice;
- `claim_generation_job` holds a five-minute processing lease, renewed between
  revisions, so two workers cannot revise one article concurrently.

## Preserving good drafts

Each revision is ranked against the best-known draft on, in order: passing,
verification status, number of failed checks, score. A worse revision never
displaces a better draft, and a tie keeps the incumbent. `posts.best_draft`
holds the best draft; `posts.latest_draft` keeps the most recent revision for
diagnosis when it was not the best.

A revision may not silently change the slug: the stored slug is reimposed on
every revision, so a canonical URL already recorded stays valid. The location,
topic and business identity are restated in every correction prompt as
`mustNotChange`.

## What it does not claim

The loop does not promise that a permanently failing article will eventually
pass. It resumes recoverable jobs, preserves unresolved drafts, and hands them
to manual review when the budgets or the article's age run out.
