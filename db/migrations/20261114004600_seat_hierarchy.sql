-- The election seat caps the hierarchy. A client's cases, escalations and team chats go up only as far as its
-- seat: a governor's campaign tops out at its state room (there is no national room above it), an LGA chairman's
-- at the LGA, a councillor's at the ward. Only a presidential client has a national room.
--   presidential                                   -> national
--   governorship, senate, reps, state_assembly     -> state  (their room is the state's room)
--   chairman, fct_area_council                     -> lga
--   councillor                                     -> ward
-- Clients set up before seats existed fall back to their coverage (national / state / LGA).
-- "Move up" (when a case runs out of time, or a supervisor escalates it) takes a case from a desk (security,
-- legal, helpdesk) to the client's own top room; a case already there stays and its supervisors are alerted.

create or replace function app.level_rank(p_level text) returns int
language sql immutable as $$
  select case p_level when 'ward' then 1 when 'lga' then 2 when 'state' then 3 when 'national' then 4 else 0 end
$$;

-- The highest level a client works at
create or replace function app.seat_level(p_tenant uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select case t.seat when 'presidential' then 'national'
                        when 'governorship' then 'state' when 'senate' then 'state' when 'reps' then 'state' when 'state_assembly' then 'state'
                        when 'chairman' then 'lga' when 'fct_area_council' then 'lga' when 'councillor' then 'ward' end
       from public.tenants t where t.id = p_tenant),
    (select case max(app.level_rank(c.level)) when 4 then 'national' when 3 then 'state' when 2 then 'lga' end
       from public.tenant_coverage c where c.tenant_id = p_tenant),
    'state')
$$;

-- The client's top room for a case in this area: the national room for a presidential client, else its state's room
create or replace function app.top_queue(p_tenant uuid, p_area text) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select q.id from public.queues q where q.tenant_id = p_tenant and q.kind = 'national' and app.seat_level(p_tenant) = 'national' limit 1),
    (select q.id from public.queues q where q.tenant_id = p_tenant and q.kind = 'state' and q.state_code = left(p_area, 2) limit 1),
    (select q.id from public.queues q where q.tenant_id = p_tenant and q.kind = 'state' order by q.state_code limit 1),
    (select q.id from public.queues q where q.tenant_id = p_tenant and q.kind = 'national' limit 1))
$$;

-- Tell the supervisors on shift for a queue
create or replace function app.alert_supervisors(p_queue uuid, p_tenant uuid, p_template text, p_data jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  select p_tenant, 'push', s.volunteer_id, p_template, p_data
    from public.shifts s where s.queue_id = p_queue and s.role = 'supervisor' and now() between s.starts_at and s.ends_at
$$;



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
  -- A "national" route for a client below national level, or a desk the client lacks: its own top room
  if v_q is null or (v_kind = 'national' and app.seat_level(p_tenant) <> 'national') then
    v_q := app.top_queue(p_tenant, p_area);
  end if;
  return v_q;
end $$;



create or replace function public.escalate_case(p_case uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  c public.cases := app.case_for_staff(p_case);
  v_top uuid := app.top_queue(c.tenant_id, c.area_code);
begin
  -- Up to the client's top room; already there: it stays, and its supervisors are told
  update public.cases set status = 'escalated', escalation_level = escalation_level + 1,
         queue_id = coalesce(v_top, queue_id), assigned_to = null where id = p_case;
  perform app.case_event(p_case, 'escalated', p_reason, jsonb_build_object('to_queue', coalesce(v_top, c.queue_id), 'moved', v_top is distinct from c.queue_id));
  perform app.alert_supervisors(coalesce(v_top, c.queue_id), c.tenant_id, 'case_escalated', jsonb_build_object('case_id', c.id, 'title', c.title));
end $$;


create or replace function app.tick_cases() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  r record;
  v_reassigned int := 0;
  v_escalated int := 0;
  v_overdue int := 0;
  v_assigned int := 0;
  v_top uuid;
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

  -- Not resolved in time: move it up to the client's top room (never past its seat), or keep it where it is
  -- (the client's choice, or already in the top room) and alert the supervisors on shift, once per deadline.
  for r in select * from public.cases
            where status in ('queued','assigned','in_progress') and due_at < now()
              and (overdue_at is null or overdue_at < due_at)
            for update skip locked loop
    v_top := app.top_queue(r.tenant_id, r.area_code);
    -- Kept where it is: by the client's choice, or because it is already in the top room (it can't go past the seat)
    if coalesce(app.rule(r.tenant_id, 'cases', r.severity, 'onMiss') #>> '{}', 'up') = 'stay' or v_top is null or v_top = r.queue_id then
      update public.cases set overdue_at = now() where id = r.id;
      perform app.case_event(r.id, 'overdue', 'Resolution deadline missed', '{}', null);
      insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
      select r.tenant_id, 'push', s.volunteer_id, 'case_overdue', jsonb_build_object('case_id', r.id, 'title', r.title)
        from public.shifts s where s.queue_id = r.queue_id and s.role = 'supervisor' and now() between s.starts_at and s.ends_at;
      v_overdue := v_overdue + 1;
      continue;
    end if;
    update public.cases set status = 'escalated', escalation_level = escalation_level + 1,
           queue_id = v_top, assigned_to = null,
           due_at = now() + make_interval(mins => app.sla_minutes(r.tenant_id, severity, 'resolve'))
     where id = r.id;
    perform app.case_event(r.id, 'escalated', 'Resolution deadline missed', jsonb_build_object('to_queue', v_top), null);
    perform app.alert_supervisors(v_top, r.tenant_id, 'case_escalated', jsonb_build_object('case_id', r.id, 'title', r.title));
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



create or replace function public.my_area_channels() returns setof public.channels
language plpgsql security definer set search_path = public as $$
declare
  me public.volunteers := app.me();
  lvl text; code text;
begin
  if me.id is null or me.level = 'national' then return; end if;
  for lvl, code in
    select * from (values ('state', left(me.area_code, 2)), ('lga', left(me.area_code, 5)), ('ward', left(me.area_code, 8))) x(l, c)
     where length(me.area_code) >= length(x.c)
       -- no team chats above the seat (an LGA chairman's campaign has no state chat)
       and app.level_rank(x.l) <= app.level_rank(app.seat_level(me.tenant_id))
  loop
    insert into public.channels (tenant_id, kind, area_code, name)
    values (me.tenant_id, lvl, code, initcap(lvl) || ' ' || code)
    on conflict (tenant_id, kind, area_code) do nothing;
  end loop;
  return query select * from public.channels
    where tenant_id = me.tenant_id and kind in ('state','lga','ward') and me.area_code like area_code || '%'
      and app.level_rank(kind) <= app.level_rank(app.seat_level(me.tenant_id));
end $$;

