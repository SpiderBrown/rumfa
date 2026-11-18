-- Rumfa Console: the platform's own staff (not members of any client), their sign-in, a log of everything they
-- change, party logos and colours, and what each client is (candidate, party, seat) and where it is served.

-- Rumfa staff. They sign in with an email identity like dashboard staff, but belong to no client, and always use
-- an authenticator code. owner: everything, including staff; staff: clients and shared data; support: read, and
-- help people sign in.
create table public.platform_staff (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid unique references public.identities(id) on delete set null,
  email text not null unique check (email = lower(email)),
  full_name text not null,
  role text not null check (role in ('owner', 'staff', 'support')),
  status text not null default 'invited' check (status in ('invited', 'active', 'suspended')),
  created_by uuid references public.platform_staff(id),
  created_at timestamptz not null default now()
);

-- One-time links to set a password (new staff, or a reset).
create table public.platform_invites (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.platform_staff(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.platform_staff(id),
  created_at timestamptz not null default now()
);

-- Console sessions (same rotation rules as client sessions, but no client or device).
create table public.platform_refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  family uuid not null,
  staff_id uuid not null references public.platform_staff(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.platform_refresh_tokens (family);

-- Everything Rumfa staff change, with who and when. Never updated or deleted.
create table public.platform_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id uuid references public.platform_staff(id),
  action text not null,                 -- e.g. client.onboard, party.logo, staff.invite
  target_type text,                     -- client, party, election, staff
  target_id text,
  tenant_id uuid references public.tenants(id) on delete set null,
  details jsonb not null default '{}'
);
create index on public.platform_audit (at desc);
create index on public.platform_audit (tenant_id, at desc);

-- Parties: a colour for maps and charts, and a logo (a small square image in the party-logos bucket)
alter table public.parties
  add column colour text check (colour ~ '^#[0-9a-fA-F]{6}$'),
  add column logo_path text,
  add column logo_version int not null default 0,
  add column updated_at timestamptz not null default now();

-- What a client is: the candidate, their party and the seat they are running for. The seat's area decides the
-- client's coverage and the level of its first coordinators.
--   presidential: NG · governorship: a state · senate: a district (20-SD1) · chairman / fct_area_council: an LGA
--   councillor: a ward · reps / state_assembly: a constituency (once constituencies are loaded)
alter table public.tenants
  add column candidate_name text,
  add column party text references public.parties(acronym),
  add column seat text check (seat in ('presidential', 'governorship', 'senate', 'reps', 'state_assembly', 'chairman', 'councillor', 'fct_area_council')),
  add column seat_area text,
  add column onboarded_by uuid references public.platform_staff(id),
  add column notes text;

-- Website addresses a client's dashboard is served on (the API allows them and serves their settings).
create table public.tenant_domains (
  domain text primary key check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+(:[0-9]+)?$'),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index on public.tenant_domains (tenant_id);

-- Only the API's own system connection reaches these
alter table public.platform_staff enable row level security;
alter table public.platform_invites enable row level security;
alter table public.platform_refresh_tokens enable row level security;
alter table public.platform_audit enable row level security;
alter table public.tenant_domains enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rumfa_api') then
    revoke all on public.platform_staff, public.platform_invites, public.platform_refresh_tokens, public.platform_audit,
      public.tenant_domains from rumfa_api;
  end if;
end $$;

-- Storage bucket for party logos (Supabase only; local storage needs nothing)
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('party-logos', 'party-logos', false) on conflict (id) do nothing;
  end if;
end $$;
