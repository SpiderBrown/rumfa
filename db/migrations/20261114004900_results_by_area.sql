-- Results page: for an area, each sub-area one level down (country → states → LGAs → wards → polling units) with
-- how many units have our signed sheet (EC8A), how many are readable on IReV, how many have both and agree,
-- how many differ, how many finished counting but have no sheet yet, and the votes by party from each source.
create or replace function public.results_by_area(p_election uuid, p_area text default 'NG')
returns table (code text, name text, units int, ours int, irev int, both_match int, differences int, missing int,
               our_votes jsonb, irev_votes jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_len int := case length(coalesce(nullif(p_area, 'NG'), '')) when 0 then 2 when 2 then 5 when 5 then 8 else 12 end;
  v_tenant uuid := app.my_tenant();
begin
  if app.my_role() not in ('analyst','supervisor','admin','legal','operator') then raise exception 'Not allowed'; end if;
  return query
  with pus as (
    select p.code as pu from public.polling_units p where p_area = 'NG' or p.code like p_area || '-%'
  ),
  ours as (
    select r.pu_code, r.votes from public.v_latest_results r
     where r.tenant_id = v_tenant and r.election_id = p_election and (p_area = 'NG' or r.pu_code like p_area || '-%')
  ),
  irev as (
    select distinct on (s.pu_code) s.pu_code, s.votes from public.irev_sheet_results s
     where s.election_id = p_election and (p_area = 'NG' or s.pu_code like p_area || '-%')
       and (s.ocr_status = 'confirmed' or (s.ocr_status = 'read' and s.min_confidence >= 0.85))
     order by s.pu_code, s.sheet_version desc
  ),
  ver as (
    select x.pu_code, x.status from public.verifications x
     where x.tenant_id = v_tenant and x.election_id = p_election and (p_area = 'NG' or x.pu_code like p_area || '-%')
  ),
  counted as (   -- counting finished (agent's live count or a quick count) but no signed sheet from us yet
    select l.pu_code from public.live_counts l where l.tenant_id = v_tenant and l.election_id = p_election and l.status = 'done'
       and (p_area = 'NG' or l.pu_code like p_area || '-%')
    union
    select q.pu_code from public.quick_tallies q where q.tenant_id = v_tenant and q.election_id = p_election
       and (p_area = 'NG' or q.pu_code like p_area || '-%')
  ),
  per as (
    select left(u.pu, v_len) as code, count(*)::int as units,
           count(o.pu_code)::int as ours, count(i.pu_code)::int as irev,
           count(*) filter (where v.status = 'verified')::int as both_match,
           count(*) filter (where v.status = 'mismatch')::int as differences,
           count(*) filter (where c.pu_code is not null and o.pu_code is null)::int as missing
      from pus u
      left join ours o on o.pu_code = u.pu
      left join irev i on i.pu_code = u.pu
      left join ver v on v.pu_code = u.pu
      left join (select distinct pu_code from counted) c on c.pu_code = u.pu
     group by 1
  ),
  ov as (select left(o.pu_code, v_len) as code, e.key as party, sum(e.value::int) as n from ours o, jsonb_each_text(o.votes) e group by 1, 2),
  iv as (select left(i.pu_code, v_len) as code, e.key as party, sum(e.value::int) as n from irev i, jsonb_each_text(i.votes) e group by 1, 2)
  select per.code,
         coalesce(st.name, lg.name, wd.name, pu.name, per.code),
         per.units, per.ours, per.irev, per.both_match, per.differences, per.missing,
         coalesce((select jsonb_object_agg(ov.party, ov.n) from ov where ov.code = per.code), '{}'::jsonb),
         coalesce((select jsonb_object_agg(iv.party, iv.n) from iv where iv.code = per.code), '{}'::jsonb)
    from per
    left join public.states st on v_len = 2 and st.code = per.code
    left join public.lgas lg on v_len = 5 and lg.code = per.code
    left join public.wards wd on v_len = 8 and wd.code = per.code
    left join public.polling_units pu on v_len = 12 and pu.code = per.code
   order by per.code;
end $$;
