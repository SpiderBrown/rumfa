-- Polling-day figures, sent by the agent as each one is announced instead of only with the final result:
--   setup          voters on the register (EC8A item 1), ballot papers received (item 3)
--   accreditation  accredited so far (repeated through the day; each update is kept)
--   close          final accredited (item 2), unused (item 4) and spoiled (item 5) ballot papers
--   result         rejected (item 6), total valid votes (item 7), used ballot papers as announced (item 8)
-- Append-only: the latest value of each figure is the current one; the history shows how the day went.
create table public.unit_figure_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  volunteer_id uuid not null references public.volunteers(id),
  stage text not null check (stage in ('setup', 'accreditation', 'close', 'result')),
  figures jsonb not null,                       -- e.g. {"registered": 650, "ballots_received": 700}
  reported_at timestamptz not null default now(), -- when the agent saved it (phone time; may be earlier when offline)
  created_at timestamptz not null default now(),
  client_id uuid unique,
  check (jsonb_typeof(figures) = 'object')
);
create index on public.unit_figure_updates (tenant_id, election_id, pu_code, reported_at);
create index on public.unit_figure_updates (tenant_id, election_id, created_at desc);

alter table public.unit_figure_updates enable row level security;
create policy unit_figures_read on public.unit_figure_updates for select to rumfa_api using (tenant_id = app.my_tenant());
grant select on public.unit_figure_updates to rumfa_api;

-- Every update reaches the situation room and the unit's area chain as it happens
create trigger unit_figures_live after insert on public.unit_figure_updates
  for each row execute function app.notify_change('id', 'tenant_id', 'pu_code', 'stage');

-- Flags raised from these figures. Each becomes an alert and a case on the desk that handles it.
insert into public.incident_categories (code, sms, label, severity, queue_kind, related, is_alert) values
  ('over_registered', null, 'Accredited voters exceed the register', 'critical', 'legal', '{}', true),
  ('over_accredited', null, 'More ballots counted than accredited voters', 'high', 'legal', '{}', true),
  ('ballots_unbalanced', null, 'Ballot papers do not balance', 'high', 'legal', '{}', true),
  ('used_mismatch', null, 'Announced used ballot papers do not add up', 'medium', 'legal', '{}', true),
  ('very_high_turnout', null, 'Unusually high turnout', 'high', 'legal', '{}', true),
  ('low_turnout', null, 'Very low turnout', 'medium', 'state', '{}', true),
  ('stronghold_low_turnout', null, 'Low turnout in a stronghold', 'high', 'state', '{}', true),
  ('accreditation_dropped', null, 'Accredited figure went down', 'low', 'state', '{}', true),
  ('no_accreditation_figures', null, 'No accreditation figures from a unit', 'medium', 'state', '{}', true)
on conflict (code) do nothing;

-- Units whose agent checked in but has sent no accreditation figure by mid-morning on election day (Lagos).
-- Run by the worker every few minutes; each unit is flagged once.
create or replace function public.svc_flag_missing_accreditation(p_after time default '11:00') returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select distinct on (k.tenant_id, k.election_id, k.pu_code) k.tenant_id, k.election_id, k.pu_code
      from public.checkins k
      join public.elections e on e.id = k.election_id
      join public.tenant_elections te on te.tenant_id = k.tenant_id and te.election_id = k.election_id and te.purpose = 'live'
     where e.election_date = (now() at time zone 'Africa/Lagos')::date
       and (now() at time zone 'Africa/Lagos')::time >= p_after
       and k.inside is not false
       and not exists (select 1 from public.unit_figure_updates u
                        where u.tenant_id = k.tenant_id and u.election_id = k.election_id and u.pu_code = k.pu_code and u.figures ? 'accredited')
  loop
    if app.raise_alert(r.tenant_id, r.election_id, 'no_accreditation_figures', r.pu_code, r.pu_code,
         jsonb_build_object('after', p_after), 'no_accreditation_figures:' || r.pu_code) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function public.svc_flag_missing_accreditation(time) from public;
