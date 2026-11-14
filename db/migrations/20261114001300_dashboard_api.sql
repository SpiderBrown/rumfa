-- Read APIs for the dashboard: aggregated so the browser never loads
-- per-unit tables for a whole state.

-- IReV data manager tree: children of an area with counts by status.
-- p_parent: 'NG' (states), '19' (LGAs), '19-28' (wards), '19-28-02' (units).
create or replace function public.irev_area_summary(p_election uuid, p_parent text)
returns table (area_code text, name text, units int, not_checked int, not_on_irev int, on_irev int,
               downloaded int, replaced int, failed int, ocr_read int, ocr_review int, ocr_confirmed int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_len int := case length(p_parent) when 2 then case when p_parent = 'NG' then 2 else 5 end when 5 then 8 else 12 end;
begin
  if not app.is_room_staff() then raise exception 'Not allowed'; end if;
  -- Limit to the tenant's coverage
  return query
  with cov as (select tc.level, tc.area_code from public.tenant_coverage tc where tc.tenant_id = app.my_tenant()),
  pu as (
    select p.code from public.polling_units p
     where (p_parent = 'NG' or p.code like p_parent || '-%')
       and exists (select 1 from cov where cov.level = 'national' or p.code like cov.area_code || '%')
  )
  select left(pu.code, v_len) as area_code,
         coalesce(s.name, l.name, w.name, u.name) as name,
         count(*)::int,
         count(*) filter (where coalesce(a.status, 'not_checked') = 'not_checked')::int,
         count(*) filter (where a.status = 'not_on_irev')::int,
         count(*) filter (where a.status = 'on_irev')::int,
         count(*) filter (where a.status = 'downloaded')::int,
         count(*) filter (where a.status = 'replaced')::int,
         count(*) filter (where a.status = 'failed')::int,
         count(*) filter (where a.ocr_status = 'read')::int,
         count(*) filter (where a.ocr_status = 'needs_review')::int,
         count(*) filter (where a.ocr_status = 'confirmed')::int
    from pu
    left join public.irev_availability a on a.pu_code = pu.code and a.election_id = p_election
    left join public.states s on v_len = 2 and s.code = left(pu.code, 2)
    left join public.lgas l on v_len = 5 and l.code = left(pu.code, 5)
    left join public.wards w on v_len = 8 and w.code = left(pu.code, 8)
    left join public.polling_units u on v_len = 12 and u.code = pu.code
   group by 1, 2
   order by 1;
end $$;

-- Live results overview per state (or per LGA inside a state).
create or replace function public.results_overview(p_election uuid, p_state text default null)
returns table (area_code text, name text, units_covered int, quick_tallies int, ec8a_reported int,
               irev_uploaded int, verified int, mismatched int)
language plpgsql stable security definer set search_path = public as $$
declare v_len int := case when p_state is null then 2 else 5 end;
begin
  if app.my_role() not in ('analyst','supervisor','admin','legal','operator') then raise exception 'Not allowed'; end if;
  return query
  with agents as (
    select distinct v.area_code as pu from public.volunteers v
     where v.tenant_id = app.my_tenant() and v.role = 'agent' and v.status in ('invited','active')
       and (p_state is null or v.area_code like p_state || '-%'))
  select left(a.pu, v_len),
         coalesce(s.name, l.name),
         count(*)::int,
         count(*) filter (where exists (select 1 from public.quick_tallies q where q.tenant_id = app.my_tenant() and q.election_id = p_election and q.pu_code = a.pu))::int,
         count(*) filter (where exists (select 1 from public.result_submissions r where r.tenant_id = app.my_tenant() and r.election_id = p_election and r.pu_code = a.pu))::int,
         count(*) filter (where exists (select 1 from public.irev_availability i where i.election_id = p_election and i.pu_code = a.pu and i.status in ('downloaded','replaced','on_irev')))::int,
         count(*) filter (where exists (select 1 from public.verifications x where x.tenant_id = app.my_tenant() and x.election_id = p_election and x.pu_code = a.pu and x.status = 'verified'))::int,
         count(*) filter (where exists (select 1 from public.verifications x where x.tenant_id = app.my_tenant() and x.election_id = p_election and x.pu_code = a.pu and x.status = 'mismatch'))::int
    from agents a
    left join public.states s on v_len = 2 and s.code = left(a.pu, 2)
    left join public.lgas l on v_len = 5 and l.code = left(a.pu, 5)
   group by 1, 2 order by 1;
end $$;

-- Tallies for the live dashboard (three stages), filtered to an area prefix.
create or replace function public.live_tallies(p_election uuid, p_area text default 'NG')
returns table (stage text, party text, votes bigint, units int)
language sql stable security definer set search_path = public as $$
  select 'quick', party, sum(votes)::bigint, sum(units)::int from public.v_quick_tally
   where tenant_id = app.my_tenant() and election_id = p_election and (p_area = 'NG' or lga_code like p_area || '%')
     and app.my_role() in ('analyst','supervisor','admin','legal','operator')
   group by party
  union all
  select 'ec8a', party, sum(votes)::bigint, sum(units)::int from public.v_tally_ec8a
   where tenant_id = app.my_tenant() and election_id = p_election and (p_area = 'NG' or lga_code like p_area || '%')
     and app.my_role() in ('analyst','supervisor','admin','legal','operator')
   group by party
  union all
  select 'irev', t.party, sum(t.votes)::bigint, sum(t.units)::int from public.v_tally_irev t
   where t.election_id = p_election and (p_area = 'NG' or t.lga_code like p_area || '%')
     and app.my_role() in ('analyst','supervisor','admin','legal','operator')
     and exists (select 1 from public.tenant_coverage c where c.tenant_id = app.my_tenant()
                  and (c.level = 'national' or t.lga_code like c.area_code || '%'))
   group by t.party
$$;

-- Room staff with their live status and open cases (for reassigning).
create or replace function public.room_staff()
returns table (id uuid, full_name text, role text, languages text[], status text, open_cases int, on_shift boolean)
language sql stable security definer set search_path = public as $$
  select v.id, v.full_name, v.role, v.languages, coalesce(st.status, 'offline'),
         (select count(*)::int from public.cases c where c.assigned_to = v.id and c.status in ('assigned','in_progress')),
         exists (select 1 from public.shifts s where s.volunteer_id = v.id and now() between s.starts_at and s.ends_at)
    from public.volunteers v left join public.staff_status st on st.volunteer_id = v.id
   where v.tenant_id = app.my_tenant() and app.is_room_staff()
     and v.role in ('operator','supervisor','legal','security','analyst') and v.status = 'active'
   order by 7 desc, 5, 6
$$;

-- Queue counters for the room header.
create or replace function public.queue_counts()
returns table (queue_id uuid, name text, kind text, waiting int, assigned int, overdue int, critical int)
language sql stable security definer set search_path = public as $$
  select q.id, q.name, q.kind,
         count(c.*) filter (where c.status in ('queued','escalated'))::int,
         count(c.*) filter (where c.status in ('assigned','in_progress'))::int,
         count(c.*) filter (where c.status not in ('resolved','closed','merged') and c.due_at < now())::int,
         count(c.*) filter (where c.status not in ('resolved','closed','merged') and c.severity = 'critical')::int
    from public.queues q left join public.cases c on c.queue_id = q.id
   where q.tenant_id = app.my_tenant() and app.is_room_staff()
   group by q.id, q.name, q.kind order by q.kind, q.name
$$;
