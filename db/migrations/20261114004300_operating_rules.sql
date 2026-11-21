-- Operating rules: each client's admins set how fast cases must move, where each kind of report goes and how
-- urgent it starts, how callbacks retry. Stored in tenants.settings.rules; anything not set keeps Rumfa's
-- defaults (the numbers that were fixed before). The functions below are the case-engine functions from
-- 20261114000500 and 20261114000600 with only those numbers swapped for the client's rules.

-- A value from the client's rules, by path (null when not set)
create or replace function app.rule(p_tenant uuid, variadic p_path text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select settings #> (array['rules'] || p_path) from public.tenants where id = p_tenant
$$;

create or replace function app.rule_int(p_tenant uuid, p_default int, variadic p_path text[]) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((app.rule(p_tenant, variadic p_path) #>> '{}')::int, p_default)
$$;

-- Minutes to take (ack) or resolve a case of this severity, for this client
create or replace function app.sla_minutes(p_tenant uuid, p_sev text, p_kind text) returns int
language sql stable security definer set search_path = public as $$
  select app.rule_int(p_tenant, app.sla_minutes(p_sev, p_kind), 'cases', p_sev, case p_kind when 'ack' then 'take' else 'resolve' end)
$$;

-- Starting severity of a report or alert, for this client (SOS is always critical)
create or replace function app.category_severity(p_tenant uuid, p_code text, p_default text) returns text
language sql stable security definer set search_path = public as $$
  select case when p_code = 'sos' then 'critical'
              else coalesce(app.rule(p_tenant, 'routing', p_code, 'severity') #>> '{}', p_default) end
$$;

-- When a case kept in place ("stay") was last flagged as overdue
alter table public.cases add column if not exists overdue_at timestamptz;

create or replace function app.route_queue(p_tenant uuid, p_category text, p_area text)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_q uuid;
begin
  select queue_kind into v_kind from public.incident_categories where code = p_category;
  -- The client's own routing wins (never for SOS)
  if p_category <> 'sos' then
    v_kind := coalesce(app.rule(p_tenant, 'routing', p_category, 'queue') #>> '{}', v_kind);
  end if;
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


create or replace function app.assign_case(p_case uuid, p_to uuid, p_by uuid default null, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c public.cases;
begin
  select * into c from public.cases where id = p_case for update;
  if c.status in ('closed','merged') then raise exception 'Case is %', c.status; end if;
  update public.cases
     set assigned_to = p_to, last_operator = p_to,
         status = case when status in ('resolved') then 'in_progress' else 'assigned' end,
         ack_due_at = now() + make_interval(mins => app.sla_minutes(c.tenant_id, severity, 'ack')),
         acknowledged_at = null
   where id = p_case;
  perform app.case_event(p_case, 'assigned', p_note, jsonb_build_object('to', p_to), p_by);
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (c.tenant_id, 'push', p_to, 'case_assigned', jsonb_build_object('case_id', p_case, 'severity', c.severity, 'title', c.title));
end $$;


create or replace function app.attach_or_open_case(
  p_tenant uuid, p_election uuid, p_pu text, p_area text, p_category text, p_severity text,
  p_title text, p_source text, p_incident uuid default null, p_alert uuid default null,
  p_force_new boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.cases;
  v_reopen int := app.rule_int(p_tenant, 120, 'cases', 'reopenMin');
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
             due_at = least(due_at, now() + make_interval(mins => app.sla_minutes(p_tenant, p_severity, 'resolve')))
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
             due_at = now() + make_interval(mins => app.sla_minutes(p_tenant, v_sev, 'resolve'))
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
          now() + make_interval(mins => app.sla_minutes(p_tenant, p_severity, 'ack')),
          now() + make_interval(mins => app.sla_minutes(p_tenant, p_severity, 'resolve')))
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
  v_sev := case when p_is_sos then 'critical' else coalesce(p_severity, app.category_severity(v.tenant_id, p_category, v_cat.severity)) end;
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
  values (p_tenant, p_election, p_rule, app.category_severity(p_tenant, p_rule, v_cat.severity), p_pu, coalesce(p_area, p_pu), p_details, p_dedupe)
  on conflict (tenant_id, dedupe_key) do nothing
  returning id into v_alert;
  if v_alert is null then return null; end if;     -- already raised
  v_case := app.attach_or_open_case(p_tenant, p_election, p_pu, coalesce(p_area, p_pu), p_rule, app.category_severity(p_tenant, p_rule, v_cat.severity),
              v_cat.label || ' · ' || coalesce(p_pu, p_area), 'alert', null, v_alert);
  return v_case;
end $$;


create or replace function public.change_case_severity(p_case uuid, p_severity text, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  if not app.is_supervisor() then raise exception 'Only a supervisor can change severity'; end if;
  update public.cases set severity = p_severity,
         due_at = coalesce(acknowledged_at, created_at) + make_interval(mins => app.sla_minutes(c.tenant_id, p_severity, 'resolve'))
   where id = p_case;
  perform app.case_event(p_case, 'severity_changed', p_reason, jsonb_build_object('from', c.severity, 'to', p_severity));
end $$;


create or replace function app.tick_cases() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_reassigned int := 0;
  v_escalated int := 0;
  v_overdue int := 0;
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

  -- Not resolved in time: escalate to the national room, or (if the client chose so for this severity)
  -- keep it where it is and alert the supervisors on shift, once per deadline.
  for r in select * from public.cases
            where status in ('queued','assigned','in_progress') and due_at < now()
              and (overdue_at is null or overdue_at < due_at)
            for update skip locked loop
    if coalesce(app.rule(r.tenant_id, 'cases', r.severity, 'onMiss') #>> '{}', 'national') = 'stay' then
      update public.cases set overdue_at = now() where id = r.id;
      perform app.case_event(r.id, 'overdue', 'Resolution deadline missed', '{}', null);
      insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
      select r.tenant_id, 'push', s.volunteer_id, 'case_overdue', jsonb_build_object('case_id', r.id, 'title', r.title)
        from public.shifts s where s.queue_id = r.queue_id and s.role = 'supervisor' and now() between s.starts_at and s.ends_at;
      v_overdue := v_overdue + 1;
      continue;
    end if;
    select id into v_nat from public.queues where tenant_id = r.tenant_id and kind = 'national';
    update public.cases set status = 'escalated', escalation_level = escalation_level + 1,
           queue_id = coalesce(v_nat, queue_id), assigned_to = null,
           due_at = now() + make_interval(mins => app.sla_minutes(r.tenant_id, severity, 'resolve'))
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

  return jsonb_build_object('reassigned', v_reassigned, 'escalated', v_escalated, 'overdue', v_overdue, 'assigned', v_assigned);
end $$;


create or replace function app.ingest_callback(p_requester uuid, p_reason text, p_voice_note text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.volunteers;
  v_existing uuid;
  v_to uuid;
  v_level int := 0;
  v_id uuid;
  v_mins int;
begin
  select * into r from public.volunteers where id = p_requester and status = 'active';
  if not found then raise exception 'Unknown requester'; end if;
  v_mins := case when p_reason = 'unit' then app.rule_int(r.tenant_id, 5, 'callbacks', 'unitMin') else app.rule_int(r.tenant_id, 10, 'callbacks', 'otherMin') end;
  select id into v_existing from public.callback_requests
   where requester_id = p_requester and status in ('waiting','calling','no_answer','escalated');
  if v_existing is not null then return jsonb_build_object('callback_id', v_existing, 'duplicate', true); end if;
  v_to := app.callback_target(p_requester, 0);
  while v_to is null and v_level < 2 loop
    v_level := v_level + 1; v_to := app.callback_target(p_requester, v_level);
  end loop;
  insert into public.callback_requests (tenant_id, requester_id, reason, voice_note_path, channel, assigned_to, escalation_level, due_at)
  values (r.tenant_id, p_requester, p_reason, p_voice_note, p_channel, v_to, v_level, now() + make_interval(mins => v_mins))
  returning id into v_id;
  if v_to is not null then
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values
      (r.tenant_id, 'push', v_to, 'callback_request', jsonb_build_object('callback_id', v_id, 'name', r.full_name, 'reason', p_reason)),
      (r.tenant_id, 'sms', v_to, 'callback_request_sms', jsonb_build_object('callback_id', v_id, 'name', r.full_name, 'phone', r.phone, 'reason', p_reason));
  else
    perform app.callback_to_room(v_id);
  end if;
  return jsonb_build_object('callback_id', v_id, 'assigned_to', v_to, 'duplicate', false);
end $$;


create or replace function public.complete_callback(p_id uuid, p_answered boolean, p_outcome text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cb public.callback_requests;
begin
  select * into cb from public.callback_requests where id = p_id and tenant_id = app.my_tenant() for update;
  if not found then raise exception 'Unknown request'; end if;
  if cb.assigned_to is distinct from app.my_id() and not app.is_room_staff() then raise exception 'Not assigned to you'; end if;
  if p_answered then
    update public.callback_requests set status = 'done', outcome = p_outcome where id = p_id;
  elsif cb.attempts >= 2 then
    update public.callback_requests set status = 'closed', outcome = coalesce(p_outcome, 'No answer after retry') where id = p_id;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (cb.tenant_id, 'sms', cb.requester_id, 'callback_missed', jsonb_build_object('callback_id', p_id));
  else
    update public.callback_requests set status = 'no_answer',
           due_at = now() + make_interval(mins => app.rule_int(cb.tenant_id, 5, 'callbacks', 'retryMin'))
     where id = p_id;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (cb.tenant_id, 'sms', cb.requester_id, 'callback_missed_retry', jsonb_build_object('callback_id', p_id, 'minutes', app.rule_int(cb.tenant_id, 5, 'callbacks', 'retryMin')));
  end if;
end $$;


create or replace function app.tick_callbacks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cb record;
  v_to uuid;
  v_level int;
  n int := 0;
begin
  for cb in select * from public.callback_requests
             where status in ('waiting','no_answer') and due_at < now()
             for update skip locked loop
    if cb.status = 'no_answer' then
      -- retry window passed: back to the same coordinator's queue
      update public.callback_requests set status = 'waiting',
             due_at = now() + make_interval(mins => case when cb.reason = 'unit' then app.rule_int(cb.tenant_id, 5, 'callbacks', 'unitMin') else app.rule_int(cb.tenant_id, 10, 'callbacks', 'otherMin') end) where id = cb.id;
      continue;
    end if;
    v_level := cb.escalation_level + 1;
    v_to := null;
    while v_to is null and v_level <= 2 loop
      v_to := app.callback_target(cb.requester_id, v_level);
      if v_to is null or v_to = cb.assigned_to then v_to := null; v_level := v_level + 1; end if;
    end loop;
    if v_to is not null then
      update public.callback_requests set assigned_to = v_to, escalation_level = v_level,
             due_at = now() + make_interval(mins => case when cb.reason = 'unit' then app.rule_int(cb.tenant_id, 5, 'callbacks', 'unitMin') else app.rule_int(cb.tenant_id, 10, 'callbacks', 'otherMin') end)
       where id = cb.id;
      insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values
        (cb.tenant_id, 'push', v_to, 'callback_request', jsonb_build_object('callback_id', cb.id, 'escalated', true)),
        (cb.tenant_id, 'sms', v_to, 'callback_request_sms', jsonb_build_object('callback_id', cb.id, 'escalated', true));
    else
      perform app.callback_to_room(cb.id);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('escalated', n);
end $$;

