# Western Cars Central AI Blog Platform

Starter implementation for a central Next.js + Supabase + OpenRouter content system. It includes a protected generation endpoint, a daily Vercel cron route, public published-post API, RSS feed, sitemap, article page, quality-gate starter, topic calendar, and SQL schema.

## Important limitations

This is a deployable starter, **not a fully audited production system**. The current cron creates/processes one weekday job and uses an HTTP request to the generation endpoint; on serverless hosting, long requests can time out. For production, move generation to a separate queue worker with atomic Postgres job claiming and bounded retries. The starter does not implement a complete Supabase Auth staff dashboard, semantic duplicate detection, reliable source-by-source fact verification, or complete RLS policies. Do not turn on auto-publishing until those are implemented and tested.

The included quality gate is intentionally conservative but not a factual guarantee. It only checks simple patterns and approved-fact strings. It cannot prove that every claim is true.

## Setup

1. Install Node.js LTS and Git.
2. Create a Supabase project. In SQL Editor, run `supabase/schema.sql`.
3. Create an OpenRouter API key.
4. Copy `.env.example` to `.env.local` and fill in the values. Generate a long random `CRON_SECRET`. Keep service-role and provider keys server-only.
5. Install dependencies: `npm install`.
6. Run locally: `npm run dev`.
7. Test the API locally using a POST to `/api/generate` with `Authorization: Bearer YOUR_CRON_SECRET` and JSON body `{"locationSlug":"brighton","topic":"Practical travel planning for visitors arriving at Brighton Station"}`.
8. Deploy the private GitHub repository to Vercel and set environment variables in Project Settings.
9. Add `content.westerncars.co.uk` in Vercel Domains and configure only the DNS record Vercel specifies. Preserve existing mail DNS records.
10. Test `/api/posts?location=brighton`, `/feed.xml?location=brighton`, `/sitemap.xml`, the cron logs and article rendering.

## Enable automatic publishing

Keep `AUTO_PUBLISH_ENABLED=false` at first. The sample code only auto-publishes if the quality gate passes and this variable is `true`; however, the starter quality gate is not enough to justify unattended publication on its own. Implement and test source-grounded claim verification, robust similarity detection, a proper atomic retry queue, staff authorization, alerting, and security policies before changing it to `true`.

## Secrets

Never commit `.env.local`, expose `SUPABASE_SERVICE_ROLE_KEY` to browser code, or use `CRON_SECRET` as a staff login. Rotate any secret that has been exposed.
