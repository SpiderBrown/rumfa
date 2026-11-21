-- IReV sheets by link: besides downloading each sheet (kept in our storage), a fetch can now save only INEC's
-- link to it. Review shows the sheet straight from INEC (passed through the API), and figures are read by
-- streaming it from INEC without keeping a copy. Downloading stays as it was and is still the default.

-- What a fetch keeps: the file (download, as before) or only INEC's link
alter table public.irev_fetch_jobs add column if not exists keep text not null default 'file' check (keep in ('file', 'link'));

-- The link a sheet is shown and read from when we don't keep the file
alter table public.irev_availability add column if not exists sheet_url text;

-- Area summary: also count units whose sheet we only have a link to (a new column, so the function is replaced)
drop function if exists public.irev_area_summary(uuid, text);
create or replace function public.irev_area_summary(p_election uuid, p_parent text)
returns table (area_code text, name text, units int, not_checked int, not_on_irev int, on_irev int,
               downloaded int, replaced int, failed int, ocr_read int, ocr_review int, ocr_confirmed int, linked int)
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
         count(*) filter (where a.ocr_status = 'confirmed')::int,
         count(*) filter (where a.storage_path is null and a.sheet_url is not null and a.status <> 'replaced')::int   -- replaced ones are counted above
    from pu
    left join public.irev_availability a on a.pu_code = pu.code and a.election_id = p_election
    left join public.states s on v_len = 2 and s.code = left(pu.code, 2)
    left join public.lgas l on v_len = 5 and l.code = left(pu.code, 5)
    left join public.wards w on v_len = 8 and w.code = left(pu.code, 8)
    left join public.polling_units u on v_len = 12 and u.code = pu.code
   group by 1, 2
   order by 1;
end $$;
