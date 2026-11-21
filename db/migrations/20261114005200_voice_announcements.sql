-- Voice announcements: a coordinator, supervisor or admin records a short message once; everyone of the chosen roles
-- in an area gets a phone call that plays it, then hangs up (one way). People out of network are tried again later:
-- every retry_min minutes, up to max_attempts calls, until ends_at. The worker places the calls (Africa's Talking);
-- the voice webhook plays the recording and records who heard it.
create table public.voice_announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  created_by uuid not null references public.volunteers(id),
  title text not null,
  area_code text not null,
  roles text[] not null,
  audio_path text not null,
  duration_s int,
  status text not null default 'sending' check (status in ('sending','done','cancelled')),
  max_attempts int not null default 4 check (max_attempts between 1 and 10),
  retry_min int not null default 10 check (retry_min between 5 and 120),
  ends_at timestamptz not null default now() + interval '3 hours',
  created_at timestamptz not null default now()
);
create index on public.voice_announcements(tenant_id, created_at desc);
alter table public.voice_announcements enable row level security;   -- reached through the API's own work only

create table public.voice_announcement_calls (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.voice_announcements(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id),
  volunteer_id uuid not null references public.volunteers(id),
  phone text not null,
  status text not null default 'waiting' check (status in ('waiting','calling','heard','no_answer','busy','failed','cancelled')),
  attempts int not null default 0,
  next_try_at timestamptz not null default now(),
  provider_session_id text unique,
  heard_s int,
  updated_at timestamptz not null default now(),
  unique (announcement_id, volunteer_id)
);
create index on public.voice_announcement_calls(status, next_try_at);
alter table public.voice_announcement_calls enable row level security;
