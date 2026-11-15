-- Live count during ballot sorting. After voting closes, INEC staff open the box and call out each
-- ballot ("APC!", "PDP!", "Invalid!") while sorting. The party agent taps that party's button in the
-- app; the app sends the running totals every few seconds. One row per polling unit, replaced in place:
-- `seq` only moves forward, so late or repeated messages never count twice. When the agent finishes,
-- the totals are also stored as the unit's quick count (sample estimate) by the API.
create table public.live_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  volunteer_id uuid not null references public.volunteers(id),
  counts jsonb not null default '{}',     -- party -> ballots called so far
  invalid int not null default 0,          -- ballots called invalid / rejected
  total int not null default 0,            -- all ballots called (parties + invalid)
  seq int not null default 0,
  status text not null default 'counting' check (status in ('counting', 'done')),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, election_id, pu_code)
);
create index on public.live_counts (tenant_id, election_id, status);

alter table public.live_counts enable row level security;
create policy live_counts_read on public.live_counts for select to rumfa_api using (tenant_id = app.my_tenant());
grant select on public.live_counts to rumfa_api;

-- Live events only when a unit starts or finishes (not on every update; the room refreshes every few seconds)
create trigger live_counts_started after insert on public.live_counts
  for each row execute function app.notify_change('id', 'tenant_id', 'pu_code', 'status');
create trigger live_counts_status after update on public.live_counts
  for each row when (old.status is distinct from new.status)
  execute function app.notify_change('id', 'tenant_id', 'pu_code', 'status');
