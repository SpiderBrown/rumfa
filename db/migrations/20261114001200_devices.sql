-- Push notification tokens (Firebase Cloud Messaging) for the mobile app.
create table public.device_tokens (
  token text primary key,
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  platform text not null check (platform in ('android','ios','web')),
  updated_at timestamptz not null default now()
);
create index on public.device_tokens(volunteer_id);
alter table public.device_tokens enable row level security;
create policy device_tokens_own on public.device_tokens for all to rumfa_api
  using (volunteer_id = app.my_id()) with check (volunteer_id = app.my_id());

create or replace function public.register_device(p_token text, p_platform text) returns void
language sql security definer set search_path = public as $$
  insert into public.device_tokens (token, volunteer_id, platform) values (p_token, app.my_id(), p_platform)
  on conflict (token) do update set volunteer_id = excluded.volunteer_id, platform = excluded.platform, updated_at = now()
$$;

-- Onboarding: confirm network with a small test top-up is done by admins;
-- the app records the person's own choice of network here.
create or replace function public.complete_onboarding(p_network text, p_languages text[]) returns void
language sql security definer set search_path = public as $$
  update public.volunteers set network = p_network, languages = p_languages,
         onboarded_at = coalesce(onboarded_at, now())
   where id = app.my_id()
$$;
