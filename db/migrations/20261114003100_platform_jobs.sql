-- Long tasks started from Rumfa Console (e.g. loading places from IReV): run in the background by the API, with
-- progress the console shows live. A job left running when the API stopped is marked failed on the next start.
create table public.platform_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                   -- geography
  params jsonb not null default '{}',
  status text not null default 'running' check (status in ('running', 'done', 'failed')),
  progress jsonb not null default '{}',
  log text[] not null default '{}',
  error text,
  started_by uuid references public.platform_staff(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index on public.platform_jobs (created_at desc);
alter table public.platform_jobs enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rumfa_api') then
    revoke all on public.platform_jobs from rumfa_api;
  end if;
end $$;
