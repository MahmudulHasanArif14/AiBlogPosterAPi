create extension if not exists pgcrypto;
create table if not exists public.locations (id uuid primary key default gen_random_uuid(), slug text unique not null, name text not null, enabled boolean not null default true, created_at timestamptz not null default now());
create table if not exists public.posts (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), title text not null, slug text not null unique, excerpt text not null, content text not null, meta_description text not null, status text not null default 'draft' check(status in ('draft','queued','published','needs_review','failed')), canonical_url text, published_at timestamptz, created_at timestamptz not null default now());
create table if not exists public.generation_jobs (id uuid primary key default gen_random_uuid(), location_id uuid not null references public.locations(id), topic text not null, status text not null default 'queued' check(status in ('queued','processing','completed','failed')), attempts integer not null default 0, error_message text, scheduled_for timestamptz not null default now(), created_at timestamptz not null default now());
create table if not exists public.content_sources (id uuid primary key default gen_random_uuid(), source_name text not null, source_type text not null, source_url text, approved boolean not null default false, notes text, updated_at timestamptz not null default now());
create table if not exists public.activity_log (id uuid primary key default gen_random_uuid(), actor_user_id uuid, action text not null, entity_type text not null, entity_id uuid, details jsonb not null default '{}'::jsonb, created_at timestamptz not null default now());
create index if not exists posts_status_published_idx on public.posts(status,published_at desc);
create index if not exists jobs_queue_idx on public.generation_jobs(status,scheduled_for);
insert into public.locations(slug,name) values ('brighton','Brighton'),('london','London'),('east-grinstead','East Grinstead'),('horley','Horley'),('crawley','Crawley'),('horsham','Horsham'),('lewes','Lewes'),('haywards-heath','Haywards Heath'),('gatwick','Gatwick'),('worthing','Worthing'),('reigate','Reigate'),('lingfield','Lingfield'),('falmer','Falmer') on conflict(slug) do nothing;
-- Before production, enable RLS and add policies for authenticated staff. Public content reads are intentionally served through server endpoints only.
alter table public.locations enable row level security;
alter table public.posts enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.content_sources enable row level security;
alter table public.activity_log enable row level security;
