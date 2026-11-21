-- Shifts are optional, and so is assigning cases automatically. Two operating rules (tenants.settings.rules.staffing):
--   useShifts  (default true):  cases are offered to people on shift for the queue, as before. When false, a
--                               queue's people are everyone whose role fits it (see app.fits_queue).
--   autoAssign (default true):  new and returned cases go straight to someone free. When false they wait in the
--                               queue: a supervisor assigns them, or staff take them from their own queues.
-- Also: "Take next case" with no queue picks the most urgent case across your own queues (it used to fail).

-- A rule that is a yes/no, with its default
create or replace function app.rule_bool(p_tenant uuid, p_default boolean, variadic p_path text[]) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((app.rule(p_tenant, variadic p_path) #>> '{}')::boolean, p_default)
$$;

-- Does this person's role and area fit this queue? Security staff work the Security desk, legal staff the Legal
-- desk, operators the area rooms and the Helpdesk; supervisors and admins fit every queue. A state room also needs
-- the person's area to cover that state (or be national).
create or replace function app.fits_queue(p_role text, p_area text, p_queue public.queues) returns boolean
language sql immutable as $$
  select case
           when p_role in ('supervisor','admin') then true
           when p_queue.kind = 'security' then p_role = 'security'
           when p_queue.kind = 'legal' then p_role = 'legal'
           else p_role = 'operator'
         end
     and (p_queue.kind <> 'state' or p_queue.state_code is null or coalesce(p_area, 'NG') = 'NG'
          or p_area = p_queue.state_code or p_area like p_queue.state_code || '-%')
$$;

-- Is this person one of the queue's people right now? With shifts: on shift for it. Without: their role fits.
create or replace function app.works_queue(p_person uuid, p_queue uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
           when app.rule_bool(q.tenant_id, true, 'staffing', 'useShifts') then
             exists (select 1 from public.shifts s where s.volunteer_id = p_person and s.queue_id = q.id and now() between s.starts_at and s.ends_at)
           else exists (select 1 from public.volunteers v where v.id = p_person and v.status = 'active' and app.fits_queue(v.role, v.area_code, q))
         end
    from public.queues q where q.id = p_queue
$$;

-- Pick someone free for a queue (fewest open cases, a shared language with the reporter first), or nobody when
-- the client assigns by hand.
create or replace function app.pick_operator(p_queue uuid, p_langs text[] default '{}')
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  q public.queues;
  v_id uuid;
begin
  select * into q from public.queues where id = p_queue;
  if not found or not app.rule_bool(q.tenant_id, true, 'staffing', 'autoAssign') then return null; end if;
  if app.rule_bool(q.tenant_id, true, 'staffing', 'useShifts') then
    select v.id into v_id
      from public.shifts s
      join public.volunteers v on v.id = s.volunteer_id and v.status = 'active'
      join public.staff_status st on st.volunteer_id = v.id and st.status = 'available'
     where s.queue_id = p_queue and now() between s.starts_at and s.ends_at
       and s.role in ('operator','supervisor')
     order by (v.languages && coalesce(p_langs, '{}')) desc,
              (s.role = 'operator') desc,          -- supervisors only when no operator is free
              (select count(*) from public.cases c where c.assigned_to = v.id and c.status in ('assigned','in_progress')) asc,
              random()
     limit 1;
  else
    select v.id into v_id
      from public.volunteers v
      join public.staff_status st on st.volunteer_id = v.id and st.status = 'available'
     where v.tenant_id = q.tenant_id and v.status = 'active' and app.fits_queue(v.role, v.area_code, q)
     order by (v.languages && coalesce(p_langs, '{}')) desc,
              (v.role in ('supervisor','admin')) asc,  -- supervisors and admins only when nobody else is free
              (select count(*) from public.cases c where c.assigned_to = v.id and c.status in ('assigned','in_progress')) asc,
              random()
     limit 1;
  end if;
  return v_id;
end $$;

-- The queues I work right now (supervisors: all of them)
create or replace function public.my_queues() returns setof uuid
language sql stable security definer set search_path = public as $$
  select q.id from public.queues q
   where q.tenant_id = app.my_tenant() and app.is_room_staff()
     and (app.is_supervisor() or app.works_queue(app.my_id(), q.id)
          or exists (select 1 from public.shifts s where s.volunteer_id = app.my_id() and s.role = 'overflow' and now() between s.starts_at and s.ends_at
                       and (select count(*) from public.cases where queue_id = q.id and status = 'queued') > q.overflow_limit))
$$;

-- Take the next case: from one queue, or (no queue) the most urgent waiting across my queues
create or replace function public.take_next_case(p_queue uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_me uuid := app.my_id();
begin
  if not app.is_room_staff() then raise exception 'Not allowed'; end if;
  if p_queue is not null then
    if not exists (select 1 from public.queues where id = p_queue and tenant_id = app.my_tenant()) then raise exception 'Unknown queue'; end if;
    if p_queue not in (select public.my_queues()) then
      raise exception '%', case when app.rule_bool(app.my_tenant(), true, 'staffing', 'useShifts')
                                then 'You are not on shift for this queue' else 'This queue is for another team' end;
    end if;
  end if;

  select id into v_id from public.cases
   where status = 'queued' and tenant_id = app.my_tenant()
     and (queue_id = p_queue or (p_queue is null and queue_id in (select public.my_queues())))
   order by app.severity_rank(severity) desc, created_at
   for update skip locked limit 1;
  if v_id is null then return null; end if;
  perform app.assign_case(v_id, v_me, v_me, 'Taken from queue');
  return v_id;
end $$;

-- Room staff with their live status, open cases, shift now and next, and the queues they work
drop function if exists public.room_staff();
create function public.room_staff()
returns table (id uuid, full_name text, role text, area_code text, languages text[], status text, open_cases int, on_shift boolean,
               next_shift_at timestamptz, queues uuid[], last_seen_at timestamptz)
language sql stable security definer set search_path = public as $$
  select v.id, v.full_name, v.role, v.area_code, v.languages, coalesce(st.status, 'offline'),
         (select count(*)::int from public.cases c where c.assigned_to = v.id and c.status in ('assigned','in_progress')),
         exists (select 1 from public.shifts s where s.volunteer_id = v.id and now() between s.starts_at and s.ends_at),
         (select min(s.starts_at) from public.shifts s where s.volunteer_id = v.id and s.starts_at > now()),
         array(select q.id from public.queues q where q.tenant_id = v.tenant_id and app.works_queue(v.id, q.id)),
         st.updated_at
    from public.volunteers v left join public.staff_status st on st.volunteer_id = v.id
   where v.tenant_id = app.my_tenant() and app.is_room_staff()
     and v.role in ('operator','supervisor','legal','security','analyst','admin') and v.status = 'active'
   order by 8 desc, 6, 7
$$;

grant execute on function public.my_queues(), public.take_next_case(uuid), public.room_staff() to rumfa_api;
