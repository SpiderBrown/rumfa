-- Entry points for trusted server code (Edge Functions, worker), exposed in
-- the public schema for PostgREST but executable only by service_role.

create or replace function public.svc_ingest_incident(p_volunteer uuid, p_pu text, p_category text, p_severity text,
  p_description text, p_source text, p_client_id uuid default null)
returns jsonb language sql security definer set search_path = public as $$
  select app.ingest_incident(p_volunteer, p_pu, p_category, p_severity, p_description, '{}', p_source, p_client_id)
$$;

create or replace function public.svc_ingest_result(p_volunteer uuid, p_pu text, p_registered int, p_accredited int,
  p_rejected int, p_total_valid int, p_votes jsonb, p_source text, p_client_id uuid default null)
returns jsonb language sql security definer set search_path = public as $$
  select app.ingest_result(p_volunteer, p_pu, p_registered, p_accredited, p_rejected, p_total_valid, p_votes, null, p_source, p_client_id)
$$;

create or replace function public.svc_ingest_callback(p_volunteer uuid, p_reason text, p_channel text)
returns jsonb language sql security definer set search_path = public as $$
  select app.ingest_callback(p_volunteer, p_reason, null, p_channel)
$$;

create or replace function public.svc_contact_call_result(p_contact uuid, p_ok boolean)
returns void language sql security definer set search_path = public as $$
  select app.contact_call_result(p_contact, p_ok)
$$;

create or replace function public.svc_verify_unit(p_election uuid, p_pu text)
returns int language sql security definer set search_path = public as $$
  select app.verify_unit_all_tenants(p_election, p_pu)
$$;

create or replace function public.svc_raise_alert(p_tenant uuid, p_election uuid, p_rule text, p_pu text, p_area text,
  p_details jsonb, p_dedupe text)
returns uuid language sql security definer set search_path = public as $$
  select app.raise_alert(p_tenant, p_election, p_rule, p_pu, p_area, p_details, p_dedupe)
$$;

create or replace function public.svc_tick() returns jsonb
language sql security definer set search_path = public as $$
  select app.tick_cases() || app.tick_callbacks()
$$;

create or replace function public.svc_case_event(p_case uuid, p_kind text, p_body text, p_data jsonb, p_actor uuid)
returns void language sql security definer set search_path = public as $$
  select app.case_event(p_case, p_kind, p_body, p_data, p_actor)
$$;

-- Units in an area for IReV jobs (area code at any level, or 'NG').
create or replace function public.svc_units_in_area(p_area text)
returns setof text language sql stable security definer set search_path = public as $$
  select code from public.polling_units where p_area = 'NG' or code like p_area || '%' order by code
$$;

-- Units already reported by agents but still missing on IReV some hours after counting.
create or replace function public.svc_flag_missing_uploads(p_election uuid, p_hours int default 4)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select s.tenant_id, s.pu_code from public.v_latest_results s
      left join public.irev_availability a on a.election_id = s.election_id and a.pu_code = s.pu_code
     where s.election_id = p_election and s.submitted_at < now() - make_interval(hours => p_hours)
       and coalesce(a.status, 'not_checked') in ('not_checked','not_on_irev')
  loop
    if app.raise_alert(r.tenant_id, p_election, 'no_upload', r.pu_code, r.pu_code,
         jsonb_build_object('hours', p_hours), 'no_upload:' || r.pu_code) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'svc_ingest_incident(uuid,text,text,text,text,text,uuid)',
    'svc_ingest_result(uuid,text,int,int,int,int,jsonb,text,uuid)',
    'svc_ingest_callback(uuid,text,text)',
    'svc_contact_call_result(uuid,boolean)',
    'svc_verify_unit(uuid,text)',
    'svc_raise_alert(uuid,uuid,text,text,text,jsonb,text)',
    'svc_tick()',
    'svc_case_event(uuid,text,text,jsonb,uuid)',
    'svc_units_in_area(text)',
    'svc_flag_missing_uploads(uuid,int)']
  loop
    execute format('revoke all on function public.%s from public', f);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function public.%s from anon, authenticated', f);
    end if;
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
