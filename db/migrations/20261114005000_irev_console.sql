-- IReV tools move to Rumfa Console (all elections, all clients): fetch jobs started by Rumfa staff belong to no client,
-- and one "watcher" job per election keeps checking IReV at a gentle interval, saving INEC's link to each new or
-- replaced sheet (no download). Clients' dashboards show progress and the sheets; they no longer start fetches.
alter table public.irev_fetch_jobs alter column tenant_id drop not null;
alter table public.irev_fetch_jobs add column requested_by_staff uuid references public.platform_staff(id);
alter table public.irev_fetch_jobs add column watcher boolean not null default false;
-- One watcher per election at a time
create unique index irev_fetch_jobs_one_watcher on public.irev_fetch_jobs(election_id)
  where watcher and status in ('queued', 'running', 'paused');

-- The same summary as the dashboard's, for the whole country (Console; owner only)
create or replace function public.svc_irev_area_summary(p_election uuid, p_parent text)
returns table (area_code text, name text, units int, not_checked int, not_on_irev int, on_irev int,
               downloaded int, replaced int, failed int, ocr_read int, ocr_review int, ocr_confirmed int, linked int)
language sql stable security definer set search_path = public as $$
  with v as (select case length(p_parent) when 2 then case when p_parent = 'NG' then 2 else 5 end when 5 then 8 else 12 end as len)
  select left(p.code, v.len),
         coalesce(s.name, l.name, w.name, u.name),
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
         count(*) filter (where a.storage_path is null and a.sheet_url is not null and a.status <> 'replaced')::int
    from v cross join public.polling_units p
    left join public.irev_availability a on a.pu_code = p.code and a.election_id = p_election
    left join public.states s on v.len = 2 and s.code = left(p.code, 2)
    left join public.lgas l on v.len = 5 and l.code = left(p.code, 5)
    left join public.wards w on v.len = 8 and w.code = left(p.code, 8)
    left join public.polling_units u on v.len = 12 and u.code = p.code
   where (p_parent = 'NG' or p.code like p_parent || '-%')
   group by 1, 2
   order by 1
$$;
revoke all on function public.svc_irev_area_summary(uuid, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'rumfa_api') then revoke all on function public.svc_irev_area_summary(uuid, text) from rumfa_api; end if;
end $$;
