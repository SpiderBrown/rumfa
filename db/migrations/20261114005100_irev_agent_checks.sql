-- Agents check IReV against their own sheet. When IReV publishes (or replaces) the result sheet of a polling unit,
-- every agent of every client at that unit is asked, by a push notification, to compare it with the signed sheet
-- they hold: "Matches" verifies the unit for their client (no one in the room needs to type it in); "Different"
-- opens a case for the legal desk. Units nobody answers for (or with no agent) stay in the room's Sheet review.
create table public.irev_unit_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  volunteer_id uuid not null references public.volunteers(id),
  status text not null default 'asked' check (status in ('asked','matches','differs')),
  note text,
  case_id uuid references public.cases(id),
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  unique (tenant_id, election_id, pu_code, volunteer_id)
);
create index on public.irev_unit_checks(volunteer_id, status);
create index on public.irev_unit_checks(tenant_id, election_id, pu_code);
alter table public.irev_unit_checks enable row level security;
create policy irev_unit_checks_read on public.irev_unit_checks for select to rumfa_api
  using (tenant_id = app.my_tenant() and (volunteer_id = app.my_id() or app.is_room_staff()));

-- Ask the unit's agents when its sheet appears on IReV or is replaced
create or replace function app.ask_irev_checks() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if new.status not in ('on_irev','downloaded','replaced') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('on_irev','downloaded','replaced')
     and old.irev_updated_at is not distinct from new.irev_updated_at and old.replaced_count is not distinct from new.replaced_count then
    return new;
  end if;
  for r in
    select v.id, v.tenant_id from public.volunteers v
      join public.tenant_elections te on te.tenant_id = v.tenant_id and te.election_id = new.election_id
     where v.role = 'agent' and v.status = 'active' and v.area_code = new.pu_code
  loop
    insert into public.irev_unit_checks (tenant_id, election_id, pu_code, volunteer_id)
    values (r.tenant_id, new.election_id, new.pu_code, r.id)
    on conflict (tenant_id, election_id, pu_code, volunteer_id) do update
      set status = 'asked', note = null, case_id = null, asked_at = now(), answered_at = null;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (r.tenant_id, 'push', r.id, 'irev_check', jsonb_build_object('pu', new.pu_code, 'election_id', new.election_id,
            'replaced', new.status = 'replaced'));
  end loop;
  return new;
end $$;
create trigger irev_availability_ask_agents after insert or update on public.irev_availability
  for each row execute function app.ask_irev_checks();

-- The agent's answer
create or replace function public.answer_irev_check(p_id uuid, p_matches boolean, p_note text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  k public.irev_unit_checks;
  s public.result_submissions;
  a jsonb;
  v_case uuid;
begin
  select * into k from public.irev_unit_checks where id = p_id and volunteer_id = app.my_id() for update;
  if not found then raise exception 'Not found'; end if;
  if p_matches then
    update public.irev_unit_checks set status = 'matches', note = p_note, answered_at = now(), case_id = null where id = p_id;
    -- Their signed sheet stands for IReV's too: the unit is verified for their client
    select * into s from public.result_submissions where tenant_id = k.tenant_id and election_id = k.election_id and pu_code = k.pu_code
     order by version desc limit 1;
    if found then
      a := app.figures_json(s.registered, s.accredited, s.rejected, s.total_valid, s.votes);
      insert into public.verifications (tenant_id, election_id, pu_code, status, agent_figures, irev_figures, sources_agreeing, diff, updated_at)
      values (k.tenant_id, k.election_id, k.pu_code, 'verified', a, a, 2, '{}', now())
      on conflict (tenant_id, election_id, pu_code) do update set status = 'verified', agent_figures = excluded.agent_figures,
        irev_figures = excluded.irev_figures, sources_agreeing = greatest(verifications.sources_agreeing, 2), diff = '{}', updated_at = now();
      update public.result_submissions set status = 'verified' where id = s.id;
    end if;
    return null;
  end if;
  v_case := app.raise_alert(k.tenant_id, k.election_id, 'irev_mismatch', k.pu_code, k.pu_code,
    jsonb_build_object('source', 'agent', 'note', p_note, 'reported_by', app.my_id()),
    'irev_agent:' || k.pu_code || ':' || k.volunteer_id || ':' || extract(epoch from k.asked_at)::bigint);
  update public.irev_unit_checks set status = 'differs', note = p_note, answered_at = now(), case_id = v_case where id = p_id;
  return v_case;
end $$;
