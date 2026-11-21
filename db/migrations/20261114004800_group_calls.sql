-- Group calls (My field team): a supervisor, admin or coordinator calls everyone of chosen roles in an area at once,
-- e.g. all coordinators in one LGA. Everyone is rung in the app into one shared LiveKit room (one app call per
-- person, tied to the group). Whoever doesn't pick up can be phoned into the same room, but only after the caller
-- confirms (phone minutes cost money): Africa's Talking rings them and, when they answer, dials the room over SIP.
create table public.group_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  created_by uuid not null references public.volunteers(id),
  area_code text not null,
  roles text[] not null,
  title text not null,
  status text not null default 'active' check (status in ('active','ended')),
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index on public.group_calls(tenant_id, started_at desc);
alter table public.group_calls enable row level security;   -- reached only through the API's own work

alter table public.calls add column group_id uuid references public.group_calls(id) on delete cascade;
create index on public.calls(group_id) where group_id is not null;

-- A phone leg into a group call ('group_phone'): Africa's Talking rings the person, then joins them to the room
do $$
declare c text;
begin
  select conname into c from pg_constraint where conrelid = 'public.calls'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%route%';
  if c is not null then execute format('alter table public.calls drop constraint %I', c); end if;
end $$;
alter table public.calls add constraint calls_route_check check (route in ('webrtc_pstn','bridged','inapp','gsm_direct','group_phone'));
