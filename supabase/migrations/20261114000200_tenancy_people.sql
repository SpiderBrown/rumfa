-- Tenants, coverage, and the people who use the platform.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','suspended','archived')),
  settings jsonb not null default '{
    "merge_window_min": 60,
    "reopen_window_min": 120,
    "related_window_min": 30,
    "callback_retry_min": 5,
    "topup_per_person_cap_ngn": 5000,
    "topup_daily_cap_ngn": 50000000,
    "irev_recheck_min": 10
  }'::jsonb,
  created_at timestamptz not null default now()
);

-- Area a tenant works in. A national tenant has one row ('national','NG').
create table public.tenant_coverage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  level text not null check (level in ('national','state','lga')),
  area_code text not null,
  primary key (tenant_id, level, area_code)
);

create table public.tenant_elections (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  election_id uuid not null references public.elections(id),
  purpose text not null default 'live' check (purpose in ('live','baseline')),
  primary key (tenant_id, election_id)
);

-- Everyone who signs in: agents, volunteers, coordinators, room staff, admins.
-- A login (auth.users) belongs to one tenant.
create table public.volunteers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid unique references auth.users(id) on delete set null,
  full_name text not null,
  phone text not null check (phone ~ '^\+234[789][01]\d{8}$'),
  role text not null check (role in ('agent','volunteer','coordinator','operator','supervisor','analyst','legal','security','voice_ops','admin')),
  level text not null check (level in ('pu','ward','lga','state','national')),
  area_code text not null,                 -- pu code for agents, ward/lga/state code for coordinators, 'NG' for national
  deputy_of uuid references public.volunteers(id),
  agent_code text,                         -- short code used in SMS (e.g. 7F3)
  languages text[] not null default '{en}',
  network text check (network in ('mtn','airtel','glo','9mobile')),
  network_confirmed_at timestamptz,
  status text not null default 'invited' check (status in ('invited','active','suspended','removed')),
  consent_calls boolean not null default true,
  onboarded_at timestamptz,
  created_by uuid references public.volunteers(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone),
  unique (tenant_id, agent_code),
  check (level <> 'pu' or area_code ~ '^\d{2}-\d{2}-\d{2}-\d{3}$'),
  check (level <> 'national' or area_code = 'NG')
);
create index on public.volunteers(tenant_id, role, level, area_code);
create index on public.volunteers(tenant_id, area_code text_pattern_ops);

-- Room staff live status and shifts.
create table public.queues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('state','security','legal','helpdesk','national')),
  state_code text references public.states(code),   -- only for kind = 'state'
  name text not null,
  overflow_limit int not null default 10,
  unique (tenant_id, kind, state_code)
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  queue_id uuid not null references public.queues(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  role text not null default 'operator' check (role in ('operator','supervisor','overflow')),
  check (ends_at > starts_at)
);
create index on public.shifts(queue_id, starts_at, ends_at);

create table public.staff_status (
  volunteer_id uuid primary key references public.volunteers(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  status text not null default 'offline' check (status in ('available','busy','away','offline')),
  updated_at timestamptz not null default now()
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id),
  actor_id uuid,                -- volunteers.id, null for the system
  action text not null,
  entity text not null,
  entity_id text,
  data jsonb,
  at timestamptz not null default now()
);
create index on public.audit_log(tenant_id, at desc);

-- ---------------------------------------------------------------------------
-- Session helpers. All are SECURITY DEFINER so RLS policies can call them
-- without recursion.
-- ---------------------------------------------------------------------------

create or replace function app.me() returns public.volunteers
language sql stable security definer set search_path = public as $$
  select v.* from public.volunteers v
  where v.user_id = auth.uid() and v.status in ('invited','active')
  limit 1
$$;

create or replace function app.my_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from public.volunteers where user_id = auth.uid() and status in ('invited','active') limit 1
$$;

create or replace function app.my_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.volunteers where user_id = auth.uid() and status in ('invited','active') limit 1
$$;

create or replace function app.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.volunteers where user_id = auth.uid() and status in ('invited','active') limit 1
$$;

create or replace function app.is_room_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('operator','supervisor','analyst','legal','security','admin')
                   from public.volunteers where user_id = auth.uid() and status = 'active' limit 1), false)
$$;

create or replace function app.is_supervisor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('supervisor','admin')
                   from public.volunteers where user_id = auth.uid() and status = 'active' limit 1), false)
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin'
                   from public.volunteers where user_id = auth.uid() and status = 'active' limit 1), false)
$$;

-- True when an area code (any level) lies inside the caller's own area.
-- Room staff at state level see their state; national staff see everything.
create or replace function app.in_my_area(code text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case when v.level = 'national' then true
                else code like v.area_code || '%' end
    from public.volunteers v where v.user_id = auth.uid() and v.status in ('invited','active') limit 1
  ), false)
$$;

create or replace function app.audit(p_tenant uuid, p_action text, p_entity text, p_entity_id text, p_data jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into public.audit_log (tenant_id, actor_id, action, entity, entity_id, data)
  values (p_tenant, app.my_id(), p_action, p_entity, p_entity_id, p_data)
$$;

create or replace function app.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger volunteers_touch before update on public.volunteers
for each row execute function app.touch_updated_at();

-- Link a new login to the volunteer record with the same phone number
-- (volunteers are invited by phone; they sign in with OTP to that phone).
create or replace function app.link_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.phone is not null then
    update public.volunteers
       set user_id = new.id, status = case when status = 'invited' then 'active' else status end
     where id = (select id from public.volunteers
                  where user_id is null
                    and phone = '+' || ltrim(new.phone, '+')
                    and status in ('invited','active')
                  order by created_at limit 1);
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function app.link_new_user();
