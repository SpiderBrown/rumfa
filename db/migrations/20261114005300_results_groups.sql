-- Results page groupings, as on Election day: the country by geopolitical zone (Z-NC …, each showing its states) and a
-- state by senatorial district (19-SD1 …, each showing its LGAs). p_group: null, 'zone' or 'senatorial'.
drop function if exists public.results_by_area(uuid, text);
create or replace function public.results_by_area(p_election uuid, p_area text default 'NG', p_group text default null)
returns table (code text, name text, units int, ours int, irev int, both_match int, differences int, missing int,
               our_votes jsonb, irev_votes jsonb)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := app.my_tenant();
  v_zone text := case when p_area ~ '^Z-(NC|NE|NW|SE|SS|SW)$' then right(p_area, 2) end;
  v_district text := case when p_area ~ '^\d{2}-SD\d$' then p_area end;
  v_by_zone boolean := p_group = 'zone' and p_area = 'NG';
  v_by_district boolean := p_group = 'senatorial' and p_area ~ '^\d{2}$';
  v_len int := case when v_zone is not null then 2 when v_district is not null then 5
                    else case length(coalesce(nullif(p_area, 'NG'), '')) when 0 then 2 when 2 then 5 when 5 then 8 else 12 end end;
  v_prefix text := case when p_area = 'NG' or v_zone is not null then '' when v_district is not null then left(p_area, 2) || '-' else p_area || '-' end;
begin
  if app.my_role() not in ('analyst','supervisor','admin','legal','operator') then raise exception 'Not allowed'; end if;
  return query
  with pus as (
    select p.code as pu,
           case when v_by_zone then 'Z-' || st.zone when v_by_district then lg.senatorial_code else left(p.code, v_len) end as k
      from public.polling_units p
      join public.lgas lg on lg.code = left(p.code, 5)
      join public.states st on st.code = left(p.code, 2)
     where p.code like v_prefix || '%'
       and (v_zone is null or st.zone = v_zone)
       and (v_district is null or lg.senatorial_code = v_district)
  ),
  ours as (
    select r.pu_code, r.votes from public.v_latest_results r
     where r.tenant_id = v_tenant and r.election_id = p_election and r.pu_code like v_prefix || '%'
  ),
  irev as (
    select distinct on (s.pu_code) s.pu_code, s.votes from public.irev_sheet_results s
     where s.election_id = p_election and s.pu_code like v_prefix || '%'
       and (s.ocr_status = 'confirmed' or (s.ocr_status = 'read' and s.min_confidence >= 0.85))
     order by s.pu_code, s.sheet_version desc
  ),
  ver as (
    select x.pu_code, x.status from public.verifications x
     where x.tenant_id = v_tenant and x.election_id = p_election and x.pu_code like v_prefix || '%'
  ),
  counted as (
    select l.pu_code from public.live_counts l where l.tenant_id = v_tenant and l.election_id = p_election and l.status = 'done' and l.pu_code like v_prefix || '%'
    union
    select q.pu_code from public.quick_tallies q where q.tenant_id = v_tenant and q.election_id = p_election and q.pu_code like v_prefix || '%'
  ),
  per as (
    select u.k as code, count(*)::int as units, count(o.pu_code)::int as ours, count(i.pu_code)::int as irev,
           count(*) filter (where v.status = 'verified')::int as both_match,
           count(*) filter (where v.status = 'mismatch')::int as differences,
           count(*) filter (where c.pu_code is not null and o.pu_code is null)::int as missing
      from pus u
      left join ours o on o.pu_code = u.pu
      left join irev i on i.pu_code = u.pu
      left join ver v on v.pu_code = u.pu
      left join counted c on c.pu_code = u.pu
     where u.k is not null
     group by 1
  ),
  ov as (select u.k as code, e.key as party, sum(e.value::int) as n from ours o join pus u on u.pu = o.pu_code, jsonb_each_text(o.votes) e group by 1, 2),
  iv as (select u.k as code, e.key as party, sum(e.value::int) as n from irev i join pus u on u.pu = i.pu_code, jsonb_each_text(i.votes) e group by 1, 2),
  zones(z, zname) as (values ('Z-NC', 'North Central'), ('Z-NE', 'North East'), ('Z-NW', 'North West'), ('Z-SE', 'South East'), ('Z-SS', 'South South'), ('Z-SW', 'South West'))
  select per.code,
         coalesce(zn.zname, sd.name, st.name, lg.name, wd.name, pu.name, per.code),
         per.units, per.ours, per.irev, per.both_match, per.differences, per.missing,
         coalesce((select jsonb_object_agg(ov.party, ov.n) from ov where ov.code = per.code), '{}'::jsonb),
         coalesce((select jsonb_object_agg(iv.party, iv.n) from iv where iv.code = per.code), '{}'::jsonb)
    from per
    left join zones zn on zn.z = per.code
    left join public.senatorial_districts sd on sd.code = per.code
    left join public.states st on length(per.code) = 2 and st.code = per.code
    left join public.lgas lg on length(per.code) = 5 and lg.code = per.code
    left join public.wards wd on length(per.code) = 8 and wd.code = per.code
    left join public.polling_units pu on length(per.code) = 12 and pu.code = per.code
   order by per.code;
end $$;
