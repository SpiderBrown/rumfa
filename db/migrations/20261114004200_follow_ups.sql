-- My field team: a coordinator (or room staff) marks that they followed up a person about something (not
-- checked in, silent, no turnout update, asked for a call, phone trouble). The person leaves the list for an
-- hour; if the problem is still there after that, they come back.
create table public.follow_ups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  need text not null check (need in ('notin', 'silent', 'turnout', 'callback', 'trouble')),
  done_by uuid not null references public.volunteers(id),
  note text,
  done_at timestamptz not null default now()
);
create index on public.follow_ups (tenant_id, volunteer_id, done_at desc);
alter table public.follow_ups enable row level security;
create policy follow_ups_tenant on public.follow_ups for all to rumfa_api
  using (tenant_id = app.my_tenant()) with check (tenant_id = app.my_tenant());
