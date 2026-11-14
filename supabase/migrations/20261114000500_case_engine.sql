-- Case engine: merging reports into cases, routing to queues, assignment,
-- escalation and the supervisor actions. All rules are fixed (no AI).

create or replace function app.setting_int(p_tenant uuid, p_key text, p_default int) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select (settings->>p_key)::int from public.tenants where id = p_tenant), p_default)
$$;

create or replace function app.sla_minutes(p_sev text, p_kind text) returns int
language sql immutable as $$
  select case p_kind
    when 'ack' then case p_sev when 'critical' then 2 when 'high' then 5 when 'medium' then 15 else 30 end
    else case p_sev when 'critical' then 10 when 'high' then 20 when 'medium' then 45 else 120 end
  end
$$;

create or replace function app.severity_rank(p_sev text) returns int
language sql immutable as $$
  select case p_sev when 'critical' then 4 when 'high' then 3 when 'medium' then 2 else 1 end
$$;

create or replace function app.case_event(p_case uuid, p_kind text, p_body text default null, p_data jsonb default '{}', p_actor uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.case_events (tenant_id, case_id, kind, actor_id, body, data)
  select c.tenant_id, c.id, p_kind, coalesce(p_actor, app.my_id()), p_body, p_data
  from public.cases c where c.id = p_case
$$;

-- Queue for a category in a state; falls back to the national queue.
create or replace function app.route_queue(p_tenant uuid, p_category text, p_area text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_q uuid;
begin
  select queue_kind into v_kind from public.incident_categories where code = p_category;
  if v_kind = 'state' then
    select id into v_q from public.queues
      where tenant_id = p_tenant and kind = 'state' and state_code = left(p_area, 2);
  else
    select id into v_q from public.queues where tenant_id = p_tenant and kind = v_kind;
  end if;
  if v_q is null then
    select id into v_q from public.queues where tenant_id = p_tenant and kind = 'national';
  end if;
  return v_q;
end $$;

-- Pick the available operator on shift for a queue with the fewest open cases,
-- preferring a shared language with the reporter.
create or replace function app.pick_operator(p_queue uuid, p_langs text[] default '{}')
returns uuid language sql stable security definer set search_path = public as $$
  select v.id
  from public.shifts s
  join public.volunteers v on v.id = s.volunteer_id and v.status = 'active'
  join public.staff_status st on st.volunteer_id = v.id and st.status = 'available'
  where s.queue_id = p_queue and now() between s.starts_at and s.ends_at
    and s.role in ('operator','supervisor')
  order by (v.languages && coalesce(p_langs, '{}')) desc,
           (s.role = 'operator') desc,          -- supervisors only when no operator is free
           (select count(*) from public.cases c where c.assigned_to = v.id and c.status in ('assigned','in_progress')) asc,
           random()
  limit 1
$$;

create or replace function app.assign_case(p_case uuid, p_to uuid, p_by uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.cases;
begin
  select * into c from public.cases where id = p_case for update;
  if c.status in ('closed','merged') then raise exception 'Case is %', c.status; end if;
  update public.cases
     set assigned_to = p_to, last_operator = p_to,
         status = case when status in ('resolved') then 'in_progress' else 'assigned' end,
         ack_due_at = now() + make_interval(mins => app.sla_minutes(severity, 'ack')),
         acknowledged_at = null
   where id = p_case;
  perform app.case_event(p_case, 'assigned', p_note, jsonb_build_object('to', p_to), p_by);
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (c.tenant_id, 'push', p_to, 'case_assigned', jsonb_build_object('case_id', p_case, 'severity', c.severity, 'title', c.title));
end $$;

create or replace function app.auto_assign(p_case uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  c public.cases;
  v_langs text[];
  v_op uuid;
begin
  select * into c from public.cases where id = p_case;
  select array_agg(distinct l) into v_langs
    from public.incidents i join public.volunteers v on v.id = i.volunteer_id, unnest(v.languages) l
   where i.case_id = p_case;
  v_op := app.pick_operator(c.queue_id, v_langs);
  if v_op is not null then
    perform app.assign_case(p_case, v_op, null, 'Auto-assigned');
  end if;
  return v_op;
end $$;

-- Recount reports and reporters on a case.
create or replace function app.recount_case(p_case uuid) returns void
language sql security definer set search_path = public as $$
  update public.cases c set
    report_count = (select count(*) from public.incidents i where i.case_id = c.id)
                 + (select count(*) from public.alerts a where a.case_id = c.id),
    reporter_count = (select count(distinct i.volunteer_id) from public.incidents i where i.case_id = c.id)
  where c.id = p_case
$$;

-- Core rule: attach a report (incident or alert) to a matching case, reopen a
-- recently resolved case, or open a new case. Returns the case id.
create or replace function app.attach_or_open_case(
  p_tenant uuid, p_election uuid, p_pu text, p_area text, p_category text, p_severity text,
  p_title text, p_source text, p_incident uuid default null, p_alert uuid default null,
  p_force_new boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.cases;
  v_reopen int := app.setting_int(p_tenant, 'reopen_window_min', 120);
  v_related int := app.setting_int(p_tenant, 'related_window_min', 30);
  v_case uuid;
  v_raised boolean := false;
  r record;
  v_sev text;
begin
  -- 1. Open case, same unit (or area) and category
  if not p_force_new then
  select * into c from public.cases
   where tenant_id = p_tenant and category = p_category
     and area_code = p_area
     and coalesce(election_id::text, '') = coalesce(p_election::text, '')
     and status in ('queued','assigned','in_progress','escalated')
   order by created_at desc limit 1
   for update;

  if found then
    v_case := c.id;
    if app.severity_rank(p_severity) > app.severity_rank(c.severity) then
      update public.cases set severity = p_severity,
             due_at = least(due_at, now() + make_interval(mins => app.sla_minutes(p_severity, 'resolve')))
       where id = v_case;
      v_raised := true;
    end if;
  else
    -- 2. Recently resolved case: reopen and return to its last operator
    select * into c from public.cases
     where tenant_id = p_tenant and category = p_category and area_code = p_area
       and coalesce(election_id::text, '') = coalesce(p_election::text, '')
       and status in ('resolved','closed')
       and coalesce(resolved_at, closed_at) > now() - make_interval(mins => v_reopen)
     order by coalesce(resolved_at, closed_at) desc limit 1
     for update;
    if found then
      v_case := c.id;
      v_sev := case when app.severity_rank(p_severity) > app.severity_rank(c.severity) then p_severity else c.severity end;
      update public.cases set status = 'queued', resolved_at = null, closed_at = null, outcome = null,
             severity = v_sev,
             due_at = now() + make_interval(mins => app.sla_minutes(v_sev, 'resolve'))
       where id = v_case;
      perform app.case_event(v_case, 'reopened', 'New matching report', '{}', null);
      if c.last_operator is not null then
        perform app.assign_case(v_case, c.last_operator, null, 'Returned to last operator');
      end if;
    end if;
  end if;
  end if;

  if v_case is not null then
    if p_incident is not null then update public.incidents set case_id = v_case where id = p_incident; end if;
    if p_alert is not null then update public.alerts set case_id = v_case where id = p_alert; end if;
    insert into public.case_merges (tenant_id, case_id, incident_id, kind) values (p_tenant, v_case, p_incident, 'auto');
    perform app.recount_case(v_case);
    perform app.case_event(v_case, 'report_merged', p_title, jsonb_build_object('incident_id', p_incident, 'alert_id', p_alert, 'severity', p_severity), null);
    select * into c from public.cases where id = v_case;
    -- A merge never delays a critical or high report
    if c.status = 'queued' and c.severity in ('critical','high') then
      perform app.auto_assign(v_case);
    elsif c.assigned_to is not null then
      insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
      values (p_tenant, 'push', c.assigned_to, 'case_updated',
              jsonb_build_object('case_id', v_case, 'reports', c.report_count, 'severity_raised', v_raised));
    end if;
    return v_case;
  end if;

  -- 3. New case
  insert into public.cases (tenant_id, election_id, queue_id, pu_code, area_code, category, severity, source, title,
                            ack_due_at, due_at)
  values (p_tenant, p_election, app.route_queue(p_tenant, p_category, p_area), p_pu, p_area, p_category, p_severity,
          p_source, p_title,
          now() + make_interval(mins => app.sla_minutes(p_severity, 'ack')),
          now() + make_interval(mins => app.sla_minutes(p_severity, 'resolve')))
  returning id into v_case;
  if p_incident is not null then update public.incidents set case_id = v_case where id = p_incident; end if;
  if p_alert is not null then update public.alerts set case_id = v_case where id = p_alert; end if;
  perform app.recount_case(v_case);
  perform app.case_event(v_case, 'created', p_title, jsonb_build_object('source', p_source), null);
  insert into public.channels (tenant_id, kind, case_id, name)
  values (p_tenant, 'case', v_case, left(p_title, 80));

  -- Suggested links: same category in same ward recently, or related category at same unit
  if p_pu is not null then
    for r in
      select id, 'same_ward_category' as reason from public.cases
       where tenant_id = p_tenant and id <> v_case and category = p_category
         and pu_code like left(p_pu, 8) || '%' and pu_code <> p_pu
         and status not in ('closed','merged')
         and created_at > now() - make_interval(mins => v_related)
      union
      select cs.id, 'same_unit_related' from public.cases cs
        join public.incident_categories ic on ic.code = p_category
       where cs.tenant_id = p_tenant and cs.id <> v_case and cs.pu_code = p_pu
         and cs.category = any(ic.related) and cs.status not in ('closed','merged')
    loop
      insert into public.case_suggestions (tenant_id, case_id, related_case_id, reason)
      values (p_tenant, v_case, r.id, r.reason) on conflict do nothing;
      perform app.case_event(v_case, 'suggestion', 'Possibly related case', jsonb_build_object('related_case_id', r.id, 'reason', r.reason), null);
    end loop;
  end if;

  if p_severity in ('critical','high') then
    perform app.auto_assign(v_case);
  end if;
  return v_case;
end $$;

-- ---------------------------------------------------------------------------
-- Reporting (called by the agent app, the SMS webhook and operators)
-- ---------------------------------------------------------------------------

create or replace function app.ingest_incident(
  p_volunteer uuid, p_pu text, p_category text, p_severity text, p_description text,
  p_media text[], p_source text, p_client_id uuid, p_is_sos boolean default false, p_election uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.volunteers;
  v_cat public.incident_categories;
  v_sev text;
  v_inc uuid;
  v_case uuid;
  v_election uuid := p_election;
begin
  if p_client_id is not null then
    select id, case_id into v_inc, v_case from public.incidents where client_id = p_client_id;
    if found then return jsonb_build_object('incident_id', v_inc, 'case_id', v_case, 'duplicate', true); end if;
  end if;
  select * into v from public.volunteers where id = p_volunteer and status = 'active';
  if not found then raise exception 'Unknown or inactive reporter'; end if;
  select * into v_cat from public.incident_categories where code = p_category and not is_alert;
  if not found then raise exception 'Unknown category %', p_category; end if;
  if v.level = 'pu' and v.area_code <> p_pu then raise exception 'Agents can only report for their own polling unit'; end if;
  if v.level <> 'pu' and v.level <> 'national' and p_pu not like v.area_code || '%' then raise exception 'Unit is outside your area'; end if;
  v_sev := case when p_is_sos then 'critical' else coalesce(p_severity, v_cat.severity) end;
  if v_election is null then
    select e.id into v_election from public.tenant_elections te join public.elections e on e.id = te.election_id
     where te.tenant_id = v.tenant_id and te.purpose = 'live' order by e.election_date limit 1;
  end if;

  insert into public.incidents (tenant_id, election_id, volunteer_id, pu_code, category, severity, is_sos, description, media_paths, source, client_id)
  values (v.tenant_id, v_election, v.id, p_pu, p_category, v_sev, p_is_sos, p_description, coalesce(p_media, '{}'), p_source, p_client_id)
  returning id into v_inc;

  v_case := app.attach_or_open_case(v.tenant_id, v_election, p_pu, p_pu, p_category, v_sev,
              v_cat.label || ' at ' || p_pu, 'incident', v_inc, null);
  return jsonb_build_object('incident_id', v_inc, 'case_id', v_case, 'duplicate', false);
end $$;

-- RPC for the app (caller is the reporter)
create or replace function public.report_incident(
  p_pu text, p_category text, p_severity text default null, p_description text default null,
  p_media text[] default '{}', p_client_id uuid default null, p_is_sos boolean default false)
returns jsonb language sql security definer set search_path = public as $$
  select app.ingest_incident(app.my_id(), p_pu, p_category, p_severity, p_description, p_media, 'app', p_client_id, p_is_sos)
$$;

-- Rule-based alerts (results checks, IReV, unanswered callbacks)
create or replace function app.raise_alert(
  p_tenant uuid, p_election uuid, p_rule text, p_pu text, p_area text, p_details jsonb, p_dedupe text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_cat public.incident_categories;
  v_alert uuid;
  v_case uuid;
begin
  select * into v_cat from public.incident_categories where code = p_rule;
  if not found then raise exception 'Unknown rule %', p_rule; end if;
  insert into public.alerts (tenant_id, election_id, rule, severity, pu_code, area_code, details, dedupe_key)
  values (p_tenant, p_election, p_rule, v_cat.severity, p_pu, coalesce(p_area, p_pu), p_details, p_dedupe)
  on conflict (tenant_id, dedupe_key) do nothing
  returning id into v_alert;
  if v_alert is null then return null; end if;     -- already raised
  v_case := app.attach_or_open_case(p_tenant, p_election, p_pu, coalesce(p_area, p_pu), p_rule, v_cat.severity,
              v_cat.label || ' · ' || coalesce(p_pu, p_area), 'alert', null, v_alert);
  return v_case;
end $$;

-- ---------------------------------------------------------------------------
-- Operator and supervisor actions
-- ---------------------------------------------------------------------------

create or replace function app.case_for_staff(p_case uuid) returns public.cases
language plpgsql security definer set search_path = public as $$
declare c public.cases;
begin
  select * into c from public.cases where id = p_case for update;
  if not found or c.tenant_id <> app.my_tenant() or not app.is_room_staff() then
    raise exception 'Not allowed';
  end if;
  return c;
end $$;

create or replace function public.take_next_case(p_queue uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_q public.queues;
  v_me uuid := app.my_id();
  v_on_shift boolean;
begin
  if not app.is_room_staff() then raise exception 'Not allowed'; end if;
  select * into v_q from public.queues where id = p_queue and tenant_id = app.my_tenant();
  if not found then raise exception 'Unknown queue'; end if;
  select exists (select 1 from public.shifts s where s.volunteer_id = v_me and now() between s.starts_at and s.ends_at
                   and (s.queue_id = p_queue
                        or (s.role = 'overflow' and (select count(*) from public.cases
                                                      where queue_id = p_queue and status = 'queued') > v_q.overflow_limit)))
    into v_on_shift;
  if not v_on_shift and not app.is_supervisor() then raise exception 'You are not on shift for this queue'; end if;

  select id into v_id from public.cases
   where queue_id = p_queue and status = 'queued'
   order by app.severity_rank(severity) desc, created_at
   for update skip locked limit 1;
  if v_id is null then return null; end if;
  perform app.assign_case(v_id, v_me, v_me, 'Taken from queue');
  return v_id;
end $$;

create or replace function public.acknowledge_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if c.assigned_to is distinct from app.my_id() then raise exception 'Case is not assigned to you'; end if;
  update public.cases set status = 'in_progress', acknowledged_at = now() where id = p_case;
  perform app.case_event(p_case, 'acknowledged');
end $$;

create or replace function public.add_case_note(p_case uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app.case_for_staff(p_case);
  perform app.case_event(p_case, 'note', p_body);
end $$;

create or replace function public.resolve_case(p_case uuid, p_outcome text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if c.status not in ('assigned','in_progress','escalated') then raise exception 'Case is %', c.status; end if;
  update public.cases set status = 'resolved', resolved_at = now(), outcome = p_outcome where id = p_case;
  perform app.case_event(p_case, 'resolved', p_outcome);
  -- Non-critical cases close straight away; critical ones wait for a supervisor
  if c.severity <> 'critical' then
    update public.cases set status = 'closed', closed_at = now(), closed_by = app.my_id() where id = p_case;
    perform app.case_event(p_case, 'closed');
  end if;
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  select distinct c.tenant_id, 'push', i.volunteer_id, 'case_resolved', jsonb_build_object('case_id', p_case, 'outcome', p_outcome)
    from public.incidents i where i.case_id = p_case and i.volunteer_id is not null;
end $$;

create or replace function public.close_case(p_case uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can confirm closing'; end if;
  if c.status <> 'resolved' then raise exception 'Case must be resolved first'; end if;
  update public.cases set status = 'closed', closed_at = now(), closed_by = app.my_id() where id = p_case;
  perform app.case_event(p_case, 'closed', 'Confirmed by supervisor');
end $$;

create or replace function public.reopen_case(p_case uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if c.status not in ('resolved','closed') then raise exception 'Case is %', c.status; end if;
  update public.cases set status = 'in_progress', resolved_at = null, closed_at = null,
         assigned_to = coalesce(assigned_to, app.my_id()) where id = p_case;
  perform app.case_event(p_case, 'reopened', p_reason);
end $$;

create or replace function public.reassign_case(p_case uuid, p_to uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can reassign'; end if;
  perform app.assign_case(p_case, p_to, app.my_id(), 'Reassigned by supervisor');
end $$;

create or replace function public.change_case_severity(p_case uuid, p_severity text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can change severity'; end if;
  update public.cases set severity = p_severity,
         due_at = coalesce(acknowledged_at, created_at) + make_interval(mins => app.sla_minutes(p_severity, 'resolve'))
   where id = p_case;
  perform app.case_event(p_case, 'severity_changed', p_reason, jsonb_build_object('from', c.severity, 'to', p_severity));
end $$;

create or replace function public.escalate_case(p_case uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.cases := app.case_for_staff(p_case);
  v_nat uuid;
begin
  select id into v_nat from public.queues where tenant_id = c.tenant_id and kind = 'national';
  update public.cases set status = 'escalated', escalation_level = escalation_level + 1,
         queue_id = coalesce(v_nat, queue_id), assigned_to = null where id = p_case;
  perform app.case_event(p_case, 'escalated', p_reason);
end $$;

-- Supervisor merges a whole case into another.
create or replace function public.merge_cases(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  s public.cases := app.case_for_staff(p_source);
  t public.cases := app.case_for_staff(p_target);
  v_inc uuid[];
  v_al uuid[];
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can merge cases'; end if;
  if s.id = t.id or s.status = 'merged' or t.status in ('merged','closed') then raise exception 'Cannot merge these cases'; end if;
  select coalesce(array_agg(id), '{}') into v_inc from public.incidents where case_id = s.id;
  select coalesce(array_agg(id), '{}') into v_al from public.alerts where case_id = s.id;
  update public.incidents set case_id = t.id where case_id = s.id;
  update public.alerts set case_id = t.id where case_id = s.id;
  update public.cases set status = 'merged', merged_into = t.id, assigned_to = null where id = s.id;
  update public.cases set severity = case when app.severity_rank(s.severity) > app.severity_rank(t.severity) then s.severity else t.severity end
   where id = t.id;
  insert into public.case_merges (tenant_id, case_id, source_case_id, kind, merged_by, moved_incident_ids, moved_alert_ids)
  values (t.tenant_id, t.id, s.id, 'manual', app.my_id(), v_inc, v_al);
  perform app.recount_case(t.id);
  perform app.case_event(t.id, 'merged', 'Merged case ' || s.id, jsonb_build_object('source_case_id', s.id));
  perform app.case_event(s.id, 'merged', 'Merged into ' || t.id, jsonb_build_object('target_case_id', t.id));
end $$;

create or replace function public.undo_merge(p_merge uuid) returns void
language plpgsql security definer set search_path = public as $$
declare m public.case_merges;
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can undo a merge'; end if;
  select * into m from public.case_merges where id = p_merge and tenant_id = app.my_tenant() and not undone for update;
  if not found then raise exception 'Unknown merge'; end if;
  if m.source_case_id is not null then
    -- move back the reports that came with the source case
    update public.incidents set case_id = m.source_case_id
     where case_id = m.case_id and id = any(m.moved_incident_ids);
    update public.alerts set case_id = m.source_case_id
     where case_id = m.case_id and id = any(m.moved_alert_ids);
    update public.cases set status = 'queued', merged_into = null where id = m.source_case_id;
    perform app.recount_case(m.source_case_id);
    perform app.case_event(m.source_case_id, 'unmerged');
  elsif m.incident_id is not null then
    -- split the report into its own new case
    update public.incidents set case_id = null where id = m.incident_id;
    perform app.attach_or_open_case(i.tenant_id, i.election_id, i.pu_code, i.pu_code, i.category, i.severity,
              'Split report at ' || i.pu_code, 'incident', i.id, null, true)
       from public.incidents i where i.id = m.incident_id;
  end if;
  update public.case_merges set undone = true where id = p_merge;
  perform app.recount_case(m.case_id);
  perform app.case_event(m.case_id, 'unmerged', null, jsonb_build_object('merge_id', p_merge));
end $$;

create or replace function public.decide_suggestion(p_suggestion uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  s public.case_suggestions;
  c public.cases;
  g uuid;
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can link cases'; end if;
  select * into s from public.case_suggestions where id = p_suggestion and tenant_id = app.my_tenant() for update;
  if not found or s.status <> 'open' then raise exception 'Unknown or decided suggestion'; end if;
  update public.case_suggestions set status = case when p_accept then 'accepted' else 'dismissed' end,
         decided_by = app.my_id() where id = p_suggestion;
  if p_accept then
    select * into c from public.cases where id = s.case_id;
    select coalesce(c.incident_group_id, (select incident_group_id from public.cases where id = s.related_case_id)) into g;
    if g is null then
      insert into public.incident_groups (tenant_id, ward_code, category, confirmed_by)
      values (c.tenant_id, left(coalesce(c.pu_code, c.area_code), 8), c.category, app.my_id()) returning id into g;
    end if;
    update public.cases set incident_group_id = g where id in (s.case_id, s.related_case_id);
    perform app.case_event(s.case_id, 'linked', null, jsonb_build_object('group_id', g, 'related_case_id', s.related_case_id));
  end if;
end $$;

-- Send a task to a field coordinator (appears in their app; logged on the case).
create or replace function public.send_case_task(p_case uuid, p_to uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (c.tenant_id, 'push', p_to, 'case_task', jsonb_build_object('case_id', p_case, 'body', p_body));
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (c.tenant_id, 'sms', p_to, 'case_task_sms', jsonb_build_object('case_id', p_case, 'body', p_body));
  perform app.case_event(p_case, 'task_sent', p_body, jsonb_build_object('to', p_to));
end $$;

create or replace function public.set_my_status(p_status text) returns void
language sql security definer set search_path = public as $$
  insert into public.staff_status (volunteer_id, tenant_id, status, updated_at)
  values (app.my_id(), app.my_tenant(), p_status, now())
  on conflict (volunteer_id) do update set status = excluded.status, updated_at = now()
$$;

-- ---------------------------------------------------------------------------
-- Timers: run every 20-60 seconds (pg_cron and/or the worker)
-- ---------------------------------------------------------------------------

create or replace function app.tick_cases() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_reassigned int := 0;
  v_escalated int := 0;
  v_assigned int := 0;
  v_nat uuid;
  v_new uuid;
begin
  -- Not acknowledged in time: reassign to someone else and alert the supervisor
  for r in select * from public.cases
            where status = 'assigned' and ack_due_at < now()
            for update skip locked loop
    perform app.case_event(r.id, 'ack_missed', null, jsonb_build_object('operator', r.assigned_to), null);
    update public.cases set assigned_to = null, status = 'queued' where id = r.id;
    v_new := app.pick_operator(r.queue_id, '{}');
    if v_new is not null and v_new <> r.assigned_to then
      perform app.assign_case(r.id, v_new, null, 'Reassigned: not acknowledged in time');
    end if;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    select r.tenant_id, 'push', s.volunteer_id, 'ack_missed', jsonb_build_object('case_id', r.id)
      from public.shifts s where s.queue_id = r.queue_id and s.role = 'supervisor' and now() between s.starts_at and s.ends_at;
    v_reassigned := v_reassigned + 1;
  end loop;

  -- Not resolved in time: escalate to the national room
  for r in select * from public.cases
            where status in ('queued','assigned','in_progress') and due_at < now()
            for update skip locked loop
    select id into v_nat from public.queues where tenant_id = r.tenant_id and kind = 'national';
    update public.cases set status = 'escalated', escalation_level = escalation_level + 1,
           queue_id = coalesce(v_nat, queue_id), assigned_to = null,
           due_at = now() + make_interval(mins => app.sla_minutes(severity, 'resolve'))
     where id = r.id;
    perform app.case_event(r.id, 'escalated', 'Resolution deadline missed', '{}', null);
    v_escalated := v_escalated + 1;
  end loop;

  -- Critical/high cases still unassigned (nobody was free): try again
  for r in select id from public.cases
            where status in ('queued','escalated') and assigned_to is null and severity in ('critical','high')
            for update skip locked loop
    if app.auto_assign(r.id) is not null then v_assigned := v_assigned + 1; end if;
  end loop;

  return jsonb_build_object('reassigned', v_reassigned, 'escalated', v_escalated, 'assigned', v_assigned);
end $$;
