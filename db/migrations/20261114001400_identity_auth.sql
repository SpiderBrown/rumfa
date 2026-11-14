-- Sign-in records used only by the API's auth module (runs as the owner).
-- None of these tables is reachable from a user request: row-level security
-- is on with no policies, and rumfa_api has no grants on them.

-- A phone activated for an identity. The app keeps the device secret; the
-- daily PIN is accepted only together with it.
create table public.auth_devices (
  id uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.identities(id) on delete cascade,
  secret_hash text not null,
  name text,
  platform text check (platform in ('android','ios','web')),
  pin_fails int not null default 0,
  locked_at timestamptz,                 -- 5 wrong PINs; cleared only by activating again
  revoked_at timestamptz,
  revoked_by uuid references public.volunteers(id),
  activated_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index on public.auth_devices(identity_id);

-- One-time codes sent by SMS or WhatsApp to activate a device.
create table public.otp_challenges (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  channel text not null check (channel in ('sms','whatsapp')),
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index on public.otp_challenges(phone, created_at desc);

-- Activation codes issued by a coordinator or admin for one membership
-- (used where SMS is unreliable or to save cost; handed out at training).
create table public.activation_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.volunteers(id),
  created_at timestamptz not null default now()
);

-- Invites for dashboard staff to set their password.
create table public.staff_invites (
  id uuid primary key default gen_random_uuid(),
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid references public.volunteers(id),
  created_at timestamptz not null default now()
);

-- Refresh tokens: one row per issued token. Each use replaces the token; a
-- reused (already replaced) token revokes its whole family.
create table public.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  family uuid not null,
  identity_id uuid not null references public.identities(id) on delete cascade,
  device_id uuid references public.auth_devices(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on public.refresh_tokens(family);

-- Fixed-window counters for sign-in rate limits (shared by all API instances).
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table public.identities enable row level security;
alter table public.auth_devices enable row level security;
alter table public.otp_challenges enable row level security;
alter table public.activation_codes enable row level security;
alter table public.staff_invites enable row level security;
alter table public.refresh_tokens enable row level security;
alter table public.rate_limits enable row level security;

-- Count a hit; returns true while the key is within its limit.
create or replace function app.rate_hit(p_key text, p_limit int, p_window interval) returns boolean
language plpgsql as $$
declare v_hits int;
begin
  insert into public.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update
    set hits = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;
