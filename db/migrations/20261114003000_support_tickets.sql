-- "Open dashboard as admin" from Rumfa Console: a one-time ticket (2 minutes, single use) that the client's dashboard
-- swaps for a Rumfa support session. Only its hash is stored.
create table public.platform_support_tickets (
  token_hash text primary key,
  staff_id uuid not null references public.platform_staff(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.platform_support_tickets enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rumfa_api') then
    revoke all on public.platform_support_tickets from rumfa_api;
  end if;
end $$;
