-- Row-level security. Writes that carry business rules go through the
-- SECURITY DEFINER functions above; direct table access is read-mostly.
-- The service role (Edge Functions, worker) bypasses RLS.

-- Coordinator starts a bridged callback: counts the attempt and returns phones.
create or replace function public.start_callback(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cb public.callback_requests;
  me public.volunteers := app.me();
  r public.volunteers;
begin
  select * into cb from public.callback_requests where id = p_id and tenant_id = me.tenant_id for update;
  if not found then raise exception 'Unknown request'; end if;
  if cb.assigned_to is distinct from me.id and not app.is_room_staff() then raise exception 'Not assigned to you'; end if;
  if cb.status not in ('waiting','no_answer','escalated') then raise exception 'Request is %', cb.status; end if;
  select * into r from public.volunteers where id = cb.requester_id;
  update public.callback_requests set status = 'calling', attempts = attempts + 1,
         assigned_to = coalesce(assigned_to, me.id) where id = p_id;
  return jsonb_build_object('caller_phone', me.phone, 'callee_phone', r.phone, 'caller_id', me.id, 'callee_id', r.id, 'tenant_id', me.tenant_id);
end $$;

-- Reference data: readable by any signed-in user ------------------------------
do $$
declare t text;
begin
  foreach t in array array['states','lgas','wards','polling_units','elections','parties','election_parties','incident_categories']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to rumfa_api using (true)', t || '_read', t);
  end loop;
end $$;

alter table public.voice_opt_outs enable row level security;   -- service role only

-- Tenancy ----------------------------------------------------------------------
alter table public.tenants enable row level security;
create policy tenants_read on public.tenants for select to rumfa_api using (id = app.my_tenant());
create policy tenants_admin on public.tenants for update to rumfa_api using (id = app.my_tenant() and app.is_admin());

alter table public.tenant_coverage enable row level security;
create policy coverage_read on public.tenant_coverage for select to rumfa_api using (tenant_id = app.my_tenant());
create policy coverage_admin on public.tenant_coverage for all to rumfa_api
  using (tenant_id = app.my_tenant() and app.is_admin()) with check (tenant_id = app.my_tenant() and app.is_admin());

alter table public.tenant_elections enable row level security;
create policy te_read on public.tenant_elections for select to rumfa_api using (tenant_id = app.my_tenant());

-- People: see yourself, people in your area, and (room staff) everyone in the tenant
alter table public.volunteers enable row level security;
create policy volunteers_read on public.volunteers for select to rumfa_api using (
  tenant_id = app.my_tenant() and (
    user_id = app.uid() or app.is_room_staff() or app.in_my_area(area_code)
    or id = (app.me()).deputy_of
    -- agents see the coordinators above them
    or (role = 'coordinator' and (app.me()).area_code like area_code || '%')
  ));
-- Coordinators add and edit people below them; admins anyone.
create policy volunteers_insert on public.volunteers for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and (
    app.is_admin()
    or (app.my_role() = 'coordinator' and role in ('agent','volunteer','coordinator') and app.in_my_area(area_code)
        and area_code <> (app.me()).area_code)
  ));
create policy volunteers_update on public.volunteers for update to rumfa_api using (
  tenant_id = app.my_tenant() and (app.is_admin() or (app.my_role() = 'coordinator' and app.in_my_area(area_code) and user_id is distinct from app.uid()))
) with check (tenant_id = app.my_tenant());

alter table public.queues enable row level security;
create policy queues_read on public.queues for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());
create policy queues_admin on public.queues for all to rumfa_api
  using (tenant_id = app.my_tenant() and app.is_admin()) with check (tenant_id = app.my_tenant() and app.is_admin());

alter table public.shifts enable row level security;
create policy shifts_read on public.shifts for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());
create policy shifts_admin on public.shifts for all to rumfa_api
  using (tenant_id = app.my_tenant() and app.is_supervisor()) with check (tenant_id = app.my_tenant() and app.is_supervisor());

alter table public.staff_status enable row level security;
create policy staff_status_read on public.staff_status for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());

alter table public.audit_log enable row level security;
create policy audit_read on public.audit_log for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_admin());

-- Field data: the reporter, coordinators above, and room staff --------------------
do $$
declare t text;
begin
  foreach t in array array['checkins','checklist_responses','quick_tallies']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy %I on public.%I for select to rumfa_api using (
      tenant_id = app.my_tenant() and (volunteer_id = app.my_id() or app.is_room_staff() or app.in_my_area(pu_code)))$p$, t || '_read', t);
    execute format($p$create policy %I on public.%I for insert to rumfa_api with check (
      tenant_id = app.my_tenant() and volunteer_id = app.my_id() and pu_code = (app.me()).area_code)$p$, t || '_insert', t);
  end loop;
end $$;
create policy checklist_update on public.checklist_responses for update to rumfa_api
  using (volunteer_id = app.my_id()) with check (volunteer_id = app.my_id());

alter table public.sample_units enable row level security;
create policy sample_read on public.sample_units for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());

alter table public.result_submissions enable row level security;
create policy results_read on public.result_submissions for select to rumfa_api using (
  tenant_id = app.my_tenant() and (volunteer_id = app.my_id()
    or (app.my_role() in ('analyst','supervisor','admin','legal')) ));

alter table public.ocr_extractions enable row level security;
create policy ocr_read on public.ocr_extractions for select to rumfa_api using (
  (tenant_id = app.my_tenant() or tenant_id is null) and app.my_role() in ('analyst','supervisor','admin','legal'));

alter table public.verifications enable row level security;
create policy verifications_read on public.verifications for select to rumfa_api using (
  tenant_id = app.my_tenant() and app.my_role() in ('analyst','supervisor','admin','legal','operator'));

-- IReV: public data, visible to results staff; jobs per tenant
alter table public.irev_availability enable row level security;
create policy irev_av_read on public.irev_availability for select to rumfa_api using (app.is_room_staff());
alter table public.irev_check_log enable row level security;
create policy irev_log_read on public.irev_check_log for select to rumfa_api using (app.is_room_staff());
alter table public.irev_sheet_results enable row level security;
create policy irev_res_read on public.irev_sheet_results for select to rumfa_api using (app.is_room_staff());
alter table public.irev_fetch_jobs enable row level security;
create policy irev_jobs_read on public.irev_fetch_jobs for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());
create policy irev_jobs_write on public.irev_fetch_jobs for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and app.my_role() in ('analyst','supervisor','admin') and requested_by = app.my_id());
create policy irev_jobs_update on public.irev_fetch_jobs for update to rumfa_api using (
  tenant_id = app.my_tenant() and app.my_role() in ('analyst','supervisor','admin'))
  with check (tenant_id = app.my_tenant());

-- Situation room ------------------------------------------------------------------
alter table public.cases enable row level security;
create policy cases_read on public.cases for select to rumfa_api using (
  tenant_id = app.my_tenant() and (
    (app.is_room_staff() and app.in_my_area(area_code))
    or exists (select 1 from public.incidents i where i.case_id = cases.id and i.volunteer_id = app.my_id())
    or (app.my_role() = 'coordinator' and app.in_my_area(area_code))
  ));

alter table public.incidents enable row level security;
create policy incidents_read on public.incidents for select to rumfa_api using (
  tenant_id = app.my_tenant() and (volunteer_id = app.my_id() or app.in_my_area(pu_code)
    or (app.is_room_staff() and app.in_my_area(pu_code))));

alter table public.alerts enable row level security;
create policy alerts_read on public.alerts for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());

alter table public.case_events enable row level security;
create policy case_events_read on public.case_events for select to rumfa_api using (
  tenant_id = app.my_tenant() and exists (select 1 from public.cases c where c.id = case_events.case_id));

alter table public.case_merges enable row level security;
create policy case_merges_read on public.case_merges for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());
alter table public.case_suggestions enable row level security;
create policy case_sugg_read on public.case_suggestions for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());
alter table public.incident_groups enable row level security;
create policy groups_read on public.incident_groups for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_room_staff());

-- Contacts: official ones are shared; tenant ones by area
alter table public.authority_contacts enable row level security;
create policy contacts_read on public.authority_contacts for select to rumfa_api using (
  (tenant_id is null or tenant_id = app.my_tenant()) and (app.is_room_staff() or app.in_my_area(area_code)
    or (app.me()).area_code like area_code || '%'));
create policy contacts_admin on public.authority_contacts for update to rumfa_api using (
  tenant_id = app.my_tenant() and app.is_admin()) with check (tenant_id = app.my_tenant());

-- Calls
alter table public.calls enable row level security;
create policy calls_read on public.calls for select to rumfa_api using (
  tenant_id = app.my_tenant() and (caller_id = app.my_id() or callee_id = app.my_id() or app.is_room_staff()));

alter table public.callback_requests enable row level security;
create policy callbacks_read on public.callback_requests for select to rumfa_api using (
  tenant_id = app.my_tenant() and (requester_id = app.my_id() or assigned_to = app.my_id() or app.is_room_staff()
    or (app.my_role() = 'coordinator' and exists (select 1 from public.volunteers r where r.id = requester_id and app.in_my_area(r.area_code)))));

-- Messaging
alter table public.channels enable row level security;
create policy channels_read on public.channels for select to rumfa_api using (app.can_access_channel(id));

alter table public.messages enable row level security;
create policy messages_read on public.messages for select to rumfa_api using (app.can_access_channel(channel_id));
create policy messages_insert on public.messages for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and sender_id = app.my_id() and kind <> 'system' and app.can_access_channel(channel_id));

alter table public.channel_reads enable row level security;
create policy reads_own on public.channel_reads for all to rumfa_api
  using (volunteer_id = app.my_id()) with check (volunteer_id = app.my_id() and app.can_access_channel(channel_id));

alter table public.live_view_requests enable row level security;
create policy lv_read on public.live_view_requests for select to rumfa_api using (
  tenant_id = app.my_tenant() and (agent_id = app.my_id() or requested_by = app.my_id() or app.is_supervisor()));

-- Back-office tables: service role only, except admins reading
alter table public.outbox enable row level security;
alter table public.sms_inbound enable row level security;
create policy sms_read on public.sms_inbound for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_admin());

-- Voice outreach: voice ops and admins
do $$
declare t text;
begin
  foreach t in array array['voice_recordings','voice_contacts','voice_campaigns','voice_call_attempts']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format($p$create policy %I on public.%I for select to rumfa_api using (
      tenant_id = app.my_tenant() and app.my_role() in ('voice_ops','admin'))$p$, t || '_read', t);
  end loop;
end $$;
create policy voice_rec_write on public.voice_recordings for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and app.my_role() in ('voice_ops','admin') and status = 'draft');
create policy voice_contacts_write on public.voice_contacts for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and app.my_role() in ('voice_ops','admin'));
create policy voice_campaign_write on public.voice_campaigns for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and app.my_role() in ('voice_ops','admin') and status = 'draft' and created_by = app.my_id());
-- Approval of recordings and campaigns: admin only, and not by the creator
create policy voice_campaign_update on public.voice_campaigns for update to rumfa_api using (
  tenant_id = app.my_tenant() and app.my_role() in ('voice_ops','admin'))
  with check (tenant_id = app.my_tenant() and (
    status in ('draft','paused','done')
    or (status = 'running' and approved_by is not null)                       -- only approved campaigns can run
    or (status = 'approved' and app.is_admin() and approved_by = app.my_id() and created_by <> app.my_id())));
create policy voice_rec_update on public.voice_recordings for update to rumfa_api using (
  tenant_id = app.my_tenant() and app.is_admin()) with check (tenant_id = app.my_tenant());

-- Top-ups: admins
do $$
declare t text;
begin
  foreach t in array array['topup_plans','topup_batches','topups']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to rumfa_api using (tenant_id = app.my_tenant() and app.is_admin())', t || '_read', t);
  end loop;
end $$;
create policy topup_plans_write on public.topup_plans for insert to rumfa_api with check (
  tenant_id = app.my_tenant() and app.is_admin() and created_by = app.my_id());

-- Function privileges: internal helpers are not callable by clients
revoke all on all functions in schema app from public;
grant usage on schema app to rumfa_api, service_role;
grant execute on function app.me(), app.my_tenant(), app.my_id(), app.my_role(), app.is_room_staff(),
  app.is_supervisor(), app.is_admin(), app.in_my_area(text), app.can_access_channel(uuid) to rumfa_api;
grant execute on all functions in schema app to service_role;
