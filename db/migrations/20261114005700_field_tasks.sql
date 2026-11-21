-- Field tasks for coordinators: from the room (a case), or made by Rumfa from what the team reports
-- (an agent not checked in when voting starts, a problem reported at one of their units).
-- A task clears by itself when the right thing happens (the agent checks in, the room resolves the case);
-- the coordinator can also say where they are with it (on my way, arrived, done) and add notes.
-- Also: an optional note on "call me" requests.

alter table public.callback_requests add column if not exists note text;

create table if not exists public.field_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid references public.elections(id),
  assignee_id uuid not null references public.volunteers(id),   -- the coordinator who should act
  about_id uuid references public.volunteers(id),               -- the agent it is about (if any)
  pu_code text references public.polling_units(code),
  case_id uuid references public.cases(id),
  kind text not null check (kind in ('room', 'not_checked_in', 'team_report')),
  title text not null,
  body text,
  priority text not null default 'normal' check (priority in ('urgent', 'high', 'normal')),
  status text not null default 'open' check (status in ('open', 'on_way', 'arrived', 'done', 'cleared')),
  created_by uuid references public.volunteers(id),
  created_at timestamptz not null default now(),
  seen_at timestamptz,
  on_way_at timestamptz,
  arrived_at timestamptz,
  done_at timestamptz,
  cleared_at timestamptz,
  cleared_reason text,
  dedupe text,
  unique (tenant_id, dedupe)
);
create index if not exists field_tasks_assignee on public.field_tasks (assignee_id, status);
create index if not exists field_tasks_about on public.field_tasks (about_id) where status not in ('done', 'cleared');
create index if not exists field_tasks_case on public.field_tasks (case_id) where case_id is not null;

create table if not exists public.field_task_notes (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id),
  task_id uuid not null references public.field_tasks(id) on delete cascade,
  author_id uuid references public.volunteers(id),
  kind text not null default 'note' check (kind in ('note', 'status', 'auto')),
  body text not null,
  at timestamptz not null default now()
);
create index if not exists field_task_notes_task on public.field_task_notes (task_id, at);

alter table public.field_tasks enable row level security;
alter table public.field_task_notes enable row level security;
drop policy if exists field_tasks_read on public.field_tasks;
create policy field_tasks_read on public.field_tasks for select to rumfa_api using (
  tenant_id = app.my_tenant() and (assignee_id = app.my_id() or app.is_room_staff()));
drop policy if exists field_task_notes_read on public.field_task_notes;
create policy field_task_notes_read on public.field_task_notes for select to rumfa_api using (
  tenant_id = app.my_tenant() and exists (select 1 from public.field_tasks t where t.id = task_id and (t.assignee_id = app.my_id() or app.is_room_staff())));

-- The coordinator closest to an area (ward, else LGA, else state), not a deputy, not the person themself
create or replace function app.nearest_coordinator(p_tenant uuid, p_area text, p_not uuid default null) returns uuid
language sql stable security definer set search_path = public as $$
  select v.id from public.volunteers v
   where v.tenant_id = p_tenant and v.role = 'coordinator' and v.status = 'active' and v.deputy_of is null
     and p_area like v.area_code || '%' and v.id is distinct from p_not
   order by length(v.area_code) desc, v.full_name limit 1
$$;

-- Opens a task once (by its dedupe key) and tells the coordinator by push
create or replace function app.open_field_task(p_tenant uuid, p_election uuid, p_to uuid, p_kind text, p_title text, p_body text,
  p_priority text, p_about uuid, p_pu text, p_case uuid, p_by uuid, p_dedupe text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if p_to is null then return null; end if;
  insert into public.field_tasks (tenant_id, election_id, assignee_id, about_id, pu_code, case_id, kind, title, body, priority, created_by, dedupe)
  values (p_tenant, p_election, p_to, p_about, p_pu, p_case, p_kind, p_title, p_body, coalesce(p_priority, 'normal'), p_by, p_dedupe)
  on conflict (tenant_id, dedupe) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (p_tenant, 'push', p_to, 'field_task', jsonb_build_object('task_id', v_id, 'title', p_title, 'body', coalesce(p_body, '')));
  end if;
  return v_id;
end $$;

-- Clears open tasks that no longer need doing, with the reason shown to the coordinator
create or replace function app.clear_field_tasks(p_where_ids uuid[], p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  with c as (
    update public.field_tasks set status = 'cleared', cleared_at = now(), cleared_reason = p_reason
     where id = any(p_where_ids) and status not in ('done', 'cleared') returning id, tenant_id)
  insert into public.field_task_notes (tenant_id, task_id, kind, body) select tenant_id, id, 'auto', p_reason from c;
end $$;

-- Room tasks are now kept as tasks too (still logged on the case and sent by push and SMS)
create or replace function public.send_case_task(p_case uuid, p_to uuid, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.cases := app.case_for_staff(p_case);
begin
  perform app.open_field_task(c.tenant_id, c.election_id, p_to, 'room', left(p_body, 120), p_body,
    case c.severity when 'critical' then 'urgent' when 'high' then 'high' else 'normal' end,
    null, null, p_case, app.my_id(), 'room:' || gen_random_uuid());
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (c.tenant_id, 'sms', p_to, 'case_task_sms', jsonb_build_object('case_id', p_case, 'body', p_body));
  perform app.case_event(p_case, 'task_sent', p_body, jsonb_build_object('to', p_to));
end $$;

-- The agent checked in: their "not checked in" task clears
create or replace function app.tg_checkin_clears_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform app.clear_field_tasks(array(
    select id from public.field_tasks where about_id = new.volunteer_id and election_id = new.election_id and kind = 'not_checked_in'
       and status not in ('done', 'cleared')), 'The agent checked in');
  return new;
end $$;
drop trigger if exists checkin_clears_tasks on public.checkins;
create trigger checkin_clears_tasks after insert on public.checkins for each row execute function app.tg_checkin_clears_tasks();

-- The room resolved or closed the case: its tasks clear
create or replace function app.tg_case_clears_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('resolved', 'closed', 'merged') and old.status is distinct from new.status then
    perform app.clear_field_tasks(array(select id from public.field_tasks where case_id = new.id and status not in ('done', 'cleared')),
      case new.status when 'merged' then 'The case was merged into another' else 'The situation room resolved the case' end);
  end if;
  return new;
end $$;
drop trigger if exists case_clears_tasks on public.cases;
create trigger case_clears_tasks after update of status on public.cases for each row execute function app.tg_case_clears_tasks();

-- Someone on the team reported a problem at a unit: the nearest coordinator gets a task to follow it up
create or replace function app.tg_incident_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_to uuid; v_label text; v_name text;
begin
  if new.case_id is null or new.volunteer_id is null or (tg_op = 'UPDATE' and old.case_id is not null) then return new; end if;
  v_to := app.nearest_coordinator(new.tenant_id, new.pu_code, new.volunteer_id);
  if v_to is null then return new; end if;
  select label into v_label from public.incident_categories where code = new.category;
  select full_name into v_name from public.volunteers where id = new.volunteer_id;
  perform app.open_field_task(new.tenant_id, new.election_id, v_to, 'team_report',
    coalesce(v_label, new.category) || ' at PU ' || new.pu_code,
    coalesce(v_name, 'An agent') || ' reported it' || coalesce(': ' || nullif(new.description, ''), '.'),
    case new.severity when 'critical' then 'urgent' when 'high' then 'high' else 'normal' end,
    new.volunteer_id, new.pu_code, new.case_id, null, 'report:' || new.case_id || ':' || v_to);
  return new;
end $$;
drop trigger if exists incident_task on public.incidents;
create trigger incident_task after insert or update of case_id on public.incidents for each row execute function app.tg_incident_task();

-- Election day, once voting has started: agents not checked in become a task for their coordinator
create or replace function public.svc_flag_not_checked_in(p_after time default '08:30') returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select v.tenant_id, te.election_id, v.id, v.full_name, v.area_code, v.phone
      from public.volunteers v
      join public.tenant_elections te on te.tenant_id = v.tenant_id and te.purpose = 'live'
      join public.elections e on e.id = te.election_id
     where e.election_date = (now() at time zone 'Africa/Lagos')::date
       and (now() at time zone 'Africa/Lagos')::time >= p_after
       and v.role = 'agent' and v.level = 'pu' and v.status = 'active'
       and not exists (select 1 from public.checkins k where k.election_id = te.election_id and k.volunteer_id = v.id)
  loop
    if app.open_field_task(r.tenant_id, r.election_id, app.nearest_coordinator(r.tenant_id, r.area_code, r.id), 'not_checked_in',
         r.full_name || ' has not checked in', 'PU ' || r.area_code || '. Voting has started. Call them, or go to the unit.',
         'high', r.id, r.area_code, null, null, 'checkin:' || r.election_id || ':' || r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function public.svc_flag_not_checked_in(time) from public;

