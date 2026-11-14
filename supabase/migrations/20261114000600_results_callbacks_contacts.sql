-- Results submission and verification, callbacks, authority contacts,
-- messaging helpers, top-ups, and live tally views.

-- ---------------------------------------------------------------------------
-- Results
-- ---------------------------------------------------------------------------

create or replace function app.result_issues(p_reg int, p_acc int, p_rej int, p_tv int, p_votes jsonb)
returns jsonb language sql immutable as $$
  with s as (select coalesce(sum(value::int), 0) as total from jsonb_each_text(p_votes))
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('code','sum_mismatch','message', format('Party votes add up to %s, but total valid votes is %s', s.total, p_tv)) as x
      from s where s.total <> p_tv
    union all
    select jsonb_build_object('code','over_accredited','message', format('Valid + rejected (%s) is more than accredited voters (%s)', p_tv + p_rej, p_acc))
      where p_tv + p_rej > p_acc
    union all
    select jsonb_build_object('code','over_registered','message', format('Accredited (%s) is more than registered voters (%s)', p_acc, p_reg))
      where p_acc > p_reg
  ) q
$$;

create or replace function app.ingest_result(
  p_volunteer uuid, p_pu text, p_registered int, p_accredited int, p_rejected int, p_total_valid int,
  p_votes jsonb, p_photo text, p_source text, p_client_id uuid, p_version int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.volunteers;
  v_election uuid;
  v_version int;
  v_id uuid;
  v_issues jsonb;
begin
  if p_client_id is not null then
    select id into v_id from public.result_submissions where client_id = p_client_id;
    if found then
      -- SMS arrived first and the app synced later: attach the photo
      if p_photo is not null then update public.result_submissions set sheet_photo_path = coalesce(sheet_photo_path, p_photo) where id = v_id; end if;
      return jsonb_build_object('submission_id', v_id, 'duplicate', true);
    end if;
  end if;
  select * into v from public.volunteers where id = p_volunteer and status = 'active';
  if not found then raise exception 'Unknown or inactive agent'; end if;
  if v.role <> 'agent' or v.area_code <> p_pu then raise exception 'Only the agent of this unit can submit its result'; end if;
  select e.id into v_election from public.tenant_elections te join public.elections e on e.id = te.election_id
   where te.tenant_id = v.tenant_id and te.purpose = 'live' and e.status in ('live','collation','upcoming')
   order by e.election_date limit 1;
  if v_election is null then raise exception 'No live election'; end if;

  -- Same figures already received by another channel (SMS vs app): merge, don't add a version
  select id into v_id from public.result_submissions
   where tenant_id = v.tenant_id and election_id = v_election and pu_code = p_pu
     and registered = p_registered and accredited = p_accredited and rejected = p_rejected
     and total_valid = p_total_valid and votes = p_votes
   order by version desc limit 1;
  if v_id is not null then
    update public.result_submissions set sheet_photo_path = coalesce(sheet_photo_path, p_photo) where id = v_id;
    return jsonb_build_object('submission_id', v_id, 'duplicate', true);
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.result_submissions
   where tenant_id = v.tenant_id and election_id = v_election and pu_code = p_pu;
  v_issues := app.result_issues(p_registered, p_accredited, p_rejected, p_total_valid, p_votes);

  insert into public.result_submissions (tenant_id, election_id, volunteer_id, pu_code, version, source,
    registered, accredited, rejected, total_valid, votes, check_issues, sheet_photo_path, client_id)
  values (v.tenant_id, v_election, v.id, p_pu, v_version, p_source,
    p_registered, p_accredited, p_rejected, p_total_valid, p_votes, v_issues, p_photo, p_client_id)
  returning id into v_id;

  perform app.verify_unit(v.tenant_id, v_election, p_pu);
  return jsonb_build_object('submission_id', v_id, 'version', v_version, 'issues', v_issues, 'duplicate', false);
end $$;

create or replace function public.submit_result(
  p_pu text, p_registered int, p_accredited int, p_rejected int, p_total_valid int,
  p_votes jsonb, p_photo text default null, p_client_id uuid default null)
returns jsonb language sql security definer set search_path = public as $$
  select app.ingest_result(app.my_id(), p_pu, p_registered, p_accredited, p_rejected, p_total_valid, p_votes, p_photo, 'app', p_client_id)
$$;

create or replace function app.figures_json(p_reg int, p_acc int, p_rej int, p_tv int, p_votes jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('registered', p_reg, 'accredited', p_acc, 'rejected', p_rej, 'totalValid', p_tv, 'votes', coalesce(p_votes, '{}'))
$$;

-- Field names that differ between two figure sets.
create or replace function app.figures_diff(a jsonb, b jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(k order by k), '{}') from (
    select k from unnest(array['registered','accredited','rejected','totalValid']) k
     where (a->>k) is distinct from (b->>k)
    union
    select 'votes.' || p from (
      select jsonb_object_keys(coalesce(a->'votes','{}')) p
      union select jsonb_object_keys(coalesce(b->'votes','{}'))
    ) parties
     where coalesce((a->'votes'->>p)::int, 0) <> coalesce((b->'votes'->>p)::int, 0)
  ) d
$$;

-- Three-source check for one unit: agent figures, OCR of the agent photo, IReV.
create or replace function app.verify_unit(p_tenant uuid, p_election uuid, p_pu text) returns text
language plpgsql security definer set search_path = public as $$
declare
  s public.result_submissions;
  a jsonb; o jsonb; i jsonb;
  ir public.irev_sheet_results;
  av public.irev_availability;
  v_status text;
  v_diff text[] := '{}';
  v_agree int := 0;
begin
  select * into s from public.result_submissions
   where tenant_id = p_tenant and election_id = p_election and pu_code = p_pu order by version desc limit 1;
  if found then a := app.figures_json(s.registered, s.accredited, s.rejected, s.total_valid, s.votes); end if;

  select figures into o from public.ocr_extractions
   where election_id = p_election and pu_code = p_pu and source = 'agent_photo' and submission_id = s.id
     and min_confidence >= 0.85
   order by created_at desc limit 1;

  select * into ir from public.irev_sheet_results
   where election_id = p_election and pu_code = p_pu and ocr_status in ('confirmed','read')
     and (ocr_status = 'confirmed' or min_confidence >= 0.85)
   order by sheet_version desc limit 1;
  if found then i := app.figures_json(ir.registered, ir.accredited, ir.rejected, ir.total_valid, ir.votes); end if;

  if a is null and i is null then return 'pending'; end if;
  if a is not null and i is not null then
    v_diff := app.figures_diff(a, i);
    v_agree := case when cardinality(v_diff) = 0 then 2 else 1 end
             + case when o is not null and cardinality(app.figures_diff(a, o)) = 0 then 1 else 0 end;
    v_status := case when cardinality(v_diff) = 0 then 'verified' else 'mismatch' end;
  elsif a is not null then
    v_status := 'agent_only';
    v_agree := case when o is not null and cardinality(app.figures_diff(a, o)) = 0 then 2 else 1 end;
  else
    v_status := 'irev_only'; v_agree := 1;
  end if;

  insert into public.verifications (tenant_id, election_id, pu_code, status, agent_figures, agent_ocr_figures, irev_figures, sources_agreeing, diff, updated_at)
  values (p_tenant, p_election, p_pu, v_status, a, o, i, v_agree, v_diff, now())
  on conflict (tenant_id, election_id, pu_code) do update set
    status = excluded.status, agent_figures = excluded.agent_figures, agent_ocr_figures = excluded.agent_ocr_figures,
    irev_figures = excluded.irev_figures, sources_agreeing = excluded.sources_agreeing, diff = excluded.diff, updated_at = now();

  if s.id is not null then
    update public.result_submissions set status = case
      when v_status = 'verified' or v_agree >= 2 then 'verified'
      when v_status = 'mismatch' or jsonb_array_length(s.check_issues) > 0 then 'flagged'
      else 'synced' end
     where id = s.id;
  end if;

  if v_status = 'mismatch' then
    perform app.raise_alert(p_tenant, p_election, 'irev_mismatch', p_pu, p_pu,
      jsonb_build_object('diff', v_diff, 'agent', a, 'irev', i, 'agent_photo', s.sheet_photo_path, 'irev_image', null),
      'irev_mismatch:' || p_pu || ':' || s.version || ':' || ir.sheet_version);
  end if;
  if s.id is not null and jsonb_array_length(s.check_issues) > 0 then
    perform app.raise_alert(p_tenant, p_election, 'arithmetic_fail', p_pu, p_pu,
      jsonb_build_object('source', 'agent', 'issues', s.check_issues), 'arith_agent:' || s.id);
  end if;
  if ir.pu_code is not null and ir.sheet_pu_code is not null and ir.sheet_pu_code <> p_pu then
    perform app.raise_alert(p_tenant, p_election, 'wrong_unit_sheet', p_pu, p_pu,
      jsonb_build_object('sheet_pu_code', ir.sheet_pu_code), 'wrong_unit:' || p_pu || ':' || ir.sheet_version);
  end if;
  select * into av from public.irev_availability where election_id = p_election and pu_code = p_pu;
  if av.replaced_count > 0 and s.id is not null and av.irev_updated_at > s.submitted_at then
    perform app.raise_alert(p_tenant, p_election, 'sheet_replaced', p_pu, p_pu,
      jsonb_build_object('replaced_count', av.replaced_count, 'irev_updated_at', av.irev_updated_at), 'replaced:' || p_pu || ':' || av.replaced_count);
  end if;
  return v_status;
end $$;

-- Re-verify a unit for every tenant that covers it (called when IReV data changes).
create or replace function app.verify_unit_all_tenants(p_election uuid, p_pu text) returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select distinct tenant_id from public.result_submissions where election_id = p_election and pu_code = p_pu loop
    perform app.verify_unit(r.tenant_id, p_election, p_pu); n := n + 1;
  end loop;
  return n;
end $$;

-- Analyst confirms or corrects OCR figures of an IReV sheet (review queue).
create or replace function public.confirm_irev_sheet(
  p_election uuid, p_pu text, p_version int, p_registered int, p_accredited int, p_rejected int, p_total_valid int, p_votes jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if app.my_role() not in ('analyst','supervisor','admin','legal') then raise exception 'Not allowed'; end if;
  update public.irev_sheet_results set registered = p_registered, accredited = p_accredited, rejected = p_rejected,
         total_valid = p_total_valid, votes = p_votes, ocr_status = 'confirmed',
         check_issues = app.result_issues(p_registered, p_accredited, p_rejected, p_total_valid, p_votes),
         reviewed_by = app.my_id(), reviewed_at = now()
   where election_id = p_election and pu_code = p_pu and sheet_version = p_version;
  update public.irev_availability set ocr_status = 'confirmed' where election_id = p_election and pu_code = p_pu;
  perform app.verify_unit_all_tenants(p_election, p_pu);
end $$;

-- ---------------------------------------------------------------------------
-- Callback requests (agent asks a coordinator to call them)
-- ---------------------------------------------------------------------------

-- Coordinator responsible at escalation level 0..2 for a requester.
create or replace function app.callback_target(p_requester uuid, p_level int) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  r public.volunteers;
  v_ward uuid;
  v_id uuid;
begin
  select * into r from public.volunteers where id = p_requester;
  select id into v_ward from public.volunteers
   where tenant_id = r.tenant_id and role = 'coordinator' and level = 'ward' and status = 'active'
     and deputy_of is null and r.area_code like area_code || '%'
   order by created_at limit 1;
  if p_level = 0 then return v_ward; end if;
  if p_level = 1 then
    select id into v_id from public.volunteers where deputy_of = v_ward and status = 'active' limit 1;
    if v_id is not null then return v_id; end if;
    p_level := 2;
  end if;
  if p_level = 2 then
    select id into v_id from public.volunteers
     where tenant_id = r.tenant_id and role = 'coordinator' and level = 'lga' and status = 'active'
       and deputy_of is null and r.area_code like area_code || '%'
     order by created_at limit 1;
    return v_id;
  end if;
  return null;
end $$;

create or replace function app.ingest_callback(p_requester uuid, p_reason text, p_voice_note text, p_channel text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r public.volunteers;
  v_existing uuid;
  v_to uuid;
  v_level int := 0;
  v_id uuid;
  v_mins int := case when p_reason = 'unit' then 5 else 10 end;
begin
  select * into r from public.volunteers where id = p_requester and status = 'active';
  if not found then raise exception 'Unknown requester'; end if;
  select id into v_existing from public.callback_requests
   where requester_id = p_requester and status in ('waiting','calling','no_answer','escalated');
  if v_existing is not null then return jsonb_build_object('callback_id', v_existing, 'duplicate', true); end if;
  v_to := app.callback_target(p_requester, 0);
  while v_to is null and v_level < 2 loop
    v_level := v_level + 1; v_to := app.callback_target(p_requester, v_level);
  end loop;
  insert into public.callback_requests (tenant_id, requester_id, reason, voice_note_path, channel, assigned_to, escalation_level, due_at)
  values (r.tenant_id, p_requester, p_reason, p_voice_note, p_channel, v_to, v_level, now() + make_interval(mins => v_mins))
  returning id into v_id;
  if v_to is not null then
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values
      (r.tenant_id, 'push', v_to, 'callback_request', jsonb_build_object('callback_id', v_id, 'name', r.full_name, 'reason', p_reason)),
      (r.tenant_id, 'sms', v_to, 'callback_request_sms', jsonb_build_object('callback_id', v_id, 'name', r.full_name, 'phone', r.phone, 'reason', p_reason));
  else
    perform app.callback_to_room(v_id);
  end if;
  return jsonb_build_object('callback_id', v_id, 'assigned_to', v_to, 'duplicate', false);
end $$;

create or replace function public.request_callback(p_reason text, p_voice_note text default null) returns jsonb
language sql security definer set search_path = public as $$
  select app.ingest_callback(app.my_id(), p_reason, p_voice_note, 'app')
$$;

create or replace function public.cancel_callback(p_id uuid) returns void
language sql security definer set search_path = public as $$
  update public.callback_requests set status = 'cancelled'
   where id = p_id and requester_id = app.my_id() and status in ('waiting','no_answer','escalated')
$$;

-- Escalation level 3: the state room takes it as a case.
create or replace function app.callback_to_room(p_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cb public.callback_requests;
  r public.volunteers;
  v_case uuid;
begin
  select * into cb from public.callback_requests where id = p_id for update;
  select * into r from public.volunteers where id = cb.requester_id;
  v_case := app.raise_alert(cb.tenant_id, cb.election_id, 'callback_unanswered',
              case when r.level = 'pu' then r.area_code end, r.area_code,
              jsonb_build_object('callback_id', cb.id, 'requester', r.id, 'name', r.full_name, 'phone', r.phone, 'reason', cb.reason),
              'callback:' || cb.id);
  update public.callback_requests set status = 'escalated', escalation_level = 3, assigned_to = null, case_id = v_case where id = p_id;
  return v_case;
end $$;

-- Coordinator marks the call outcome (the bridge itself is started by the Edge Function).
create or replace function public.complete_callback(p_id uuid, p_answered boolean, p_outcome text default null) returns void
language plpgsql security definer set search_path = public as $$
declare cb public.callback_requests;
begin
  select * into cb from public.callback_requests where id = p_id and tenant_id = app.my_tenant() for update;
  if not found then raise exception 'Unknown request'; end if;
  if cb.assigned_to is distinct from app.my_id() and not app.is_room_staff() then raise exception 'Not assigned to you'; end if;
  if p_answered then
    update public.callback_requests set status = 'done', outcome = p_outcome where id = p_id;
  elsif cb.attempts >= 2 then
    update public.callback_requests set status = 'closed', outcome = coalesce(p_outcome, 'No answer after retry') where id = p_id;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (cb.tenant_id, 'sms', cb.requester_id, 'callback_missed', jsonb_build_object('callback_id', p_id));
  else
    update public.callback_requests set status = 'no_answer',
           due_at = now() + make_interval(mins => app.setting_int(cb.tenant_id, 'callback_retry_min', 5))
     where id = p_id;
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (cb.tenant_id, 'sms', cb.requester_id, 'callback_missed_retry', jsonb_build_object('callback_id', p_id));
  end if;
end $$;

create or replace function public.convert_callback_to_case(p_id uuid, p_category text, p_note text) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  cb public.callback_requests;
  r public.volunteers;
  v jsonb;
begin
  select * into cb from public.callback_requests where id = p_id and tenant_id = app.my_tenant() for update;
  if not found then raise exception 'Unknown request'; end if;
  select * into r from public.volunteers where id = cb.requester_id;
  if r.level <> 'pu' then raise exception 'Only polling-unit requests can become unit cases'; end if;
  v := app.ingest_incident(r.id, r.area_code, p_category, null, p_note, '{}', 'call', null);
  update public.callback_requests set status = 'case_opened', case_id = (v->>'case_id')::uuid where id = p_id;
  return (v->>'case_id')::uuid;
end $$;

create or replace function app.tick_callbacks() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cb record;
  v_to uuid;
  v_level int;
  n int := 0;
begin
  for cb in select * from public.callback_requests
             where status in ('waiting','no_answer') and due_at < now()
             for update skip locked loop
    if cb.status = 'no_answer' then
      -- retry window passed: back to the same coordinator's queue
      update public.callback_requests set status = 'waiting',
             due_at = now() + make_interval(mins => case when cb.reason = 'unit' then 5 else 10 end) where id = cb.id;
      continue;
    end if;
    v_level := cb.escalation_level + 1;
    v_to := null;
    while v_to is null and v_level <= 2 loop
      v_to := app.callback_target(cb.requester_id, v_level);
      if v_to is null or v_to = cb.assigned_to then v_to := null; v_level := v_level + 1; end if;
    end loop;
    if v_to is not null then
      update public.callback_requests set assigned_to = v_to, escalation_level = v_level,
             due_at = now() + make_interval(mins => case when cb.reason = 'unit' then 5 else 10 end)
       where id = cb.id;
      insert into public.outbox (tenant_id, channel, to_volunteer, template, data) values
        (cb.tenant_id, 'push', v_to, 'callback_request', jsonb_build_object('callback_id', cb.id, 'escalated', true)),
        (cb.tenant_id, 'sms', v_to, 'callback_request_sms', jsonb_build_object('callback_id', cb.id, 'escalated', true));
    else
      perform app.callback_to_room(cb.id);
    end if;
    n := n + 1;
  end loop;
  return jsonb_build_object('escalated', n);
end $$;

-- ---------------------------------------------------------------------------
-- Authority contacts
-- ---------------------------------------------------------------------------

create or replace function public.add_authority_contact(
  p_agency text, p_title text, p_person text, p_phone text, p_level text, p_area text, p_notes text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  me public.volunteers := app.me();
  v_id uuid;
begin
  if me.role not in ('coordinator','supervisor','admin') then raise exception 'Not allowed'; end if;
  if me.level <> 'national' and p_area not like me.area_code || '%' then raise exception 'Area outside your assignment'; end if;
  insert into public.authority_contacts (tenant_id, agency, title, person_name, phone, level, area_code, status, source_type, added_by, notes)
  values (me.tenant_id, p_agency, p_title, p_person, p_phone, p_level, p_area, 'pending', 'coordinator', me.id, p_notes)
  returning id into v_id;
  return v_id;
end $$;

-- Result of the in-app test call (also set by the call webhook).
create or replace function app.contact_call_result(p_contact uuid, p_ok boolean) returns void
language sql security definer set search_path = public as $$
  update public.authority_contacts set
    status = case when p_ok and status in ('pending','draft') then 'call_tested'
                  when p_ok and status = 'stale' then 'verified'
                  when not p_ok then 'pending' else status end,
    last_call_ok_at = case when p_ok then now() else last_call_ok_at end,
    last_call_failed_at = case when not p_ok then now() else last_call_failed_at end
  where id = p_contact
$$;

create or replace function public.mark_contact_call(p_contact uuid, p_ok boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.authority_contacts where id = p_contact
                   and (tenant_id = app.my_tenant() or tenant_id is null)) then raise exception 'Unknown contact'; end if;
  perform app.contact_call_result(p_contact, p_ok);
  if not p_ok then
    insert into public.outbox (tenant_id, channel, template, data)
    select app.my_tenant(), 'push', 'contact_call_failed', jsonb_build_object('contact_id', p_contact);
  end if;
end $$;

-- Approval by a coordinator at the level above (or a supervisor/admin).
create or replace function public.approve_contact(p_contact uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  me public.volunteers := app.me();
  c public.authority_contacts;
  adder public.volunteers;
begin
  select * into c from public.authority_contacts where id = p_contact and (tenant_id = me.tenant_id or tenant_id is null) for update;
  if not found then raise exception 'Unknown contact'; end if;
  if c.status <> 'call_tested' then raise exception 'The number must pass a test call first'; end if;
  select * into adder from public.volunteers where id = c.added_by;
  if me.role not in ('supervisor','admin') then
    if me.role <> 'coordinator' then raise exception 'Not allowed'; end if;
    if adder.id = me.id then raise exception 'You cannot approve your own contact'; end if;
    if not (c.area_code like me.area_code || '%' and length(me.area_code) < length(c.area_code)) and me.level <> 'national' then
      raise exception 'Only the level above can approve';
    end if;
  end if;
  update public.authority_contacts set status = case when p_approve then 'verified' else 'rejected' end,
         approved_by = me.id, approved_at = now() where id = p_contact;
  perform app.audit(me.tenant_id, case when p_approve then 'contact_approved' else 'contact_rejected' end, 'authority_contact', p_contact::text);
end $$;

-- Mark verified contacts stale if not re-confirmed recently (run in the final week).
create or replace function app.mark_stale_contacts(p_days int default 7) returns int
language sql security definer set search_path = public as $$
  with u as (
    update public.authority_contacts set status = 'stale'
     where status = 'verified' and coalesce(last_call_ok_at, approved_at, created_at) < now() - make_interval(days => p_days)
    returning 1)
  select count(*)::int from u
$$;

-- ---------------------------------------------------------------------------
-- Messaging
-- ---------------------------------------------------------------------------

create or replace function app.can_access_channel(p_channel uuid) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  ch public.channels;
  me public.volunteers := app.me();
  c public.cases;
begin
  if me.id is null then return false; end if;
  select * into ch from public.channels where id = p_channel;
  if not found or ch.tenant_id <> me.tenant_id then return false; end if;
  if ch.kind = 'direct' then return me.id in (ch.member_a, ch.member_b); end if;
  if ch.kind = 'case' then
    select * into c from public.cases where id = ch.case_id;
    if app.is_room_staff() and app.in_my_area(c.area_code) then return true; end if;
    return exists (select 1 from public.incidents i where i.case_id = c.id and i.volunteer_id = me.id)
        or (me.role = 'coordinator' and c.area_code like me.area_code || '%')
        or exists (select 1 from public.case_events e where e.case_id = c.id and e.kind = 'task_sent' and (e.data->>'to')::uuid = me.id);
  end if;
  -- area channel: everyone whose own area lies inside it, plus coordinators/staff above it
  return me.area_code like ch.area_code || '%' or ch.area_code like me.area_code || '%' or me.level = 'national';
end $$;

create or replace function public.open_direct_channel(p_other uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me uuid := app.my_id();
  a uuid := least(me, p_other);
  b uuid := greatest(me, p_other);
  v_id uuid;
begin
  if not exists (select 1 from public.volunteers where id = p_other and tenant_id = app.my_tenant()) then raise exception 'Unknown person'; end if;
  select id into v_id from public.channels where kind = 'direct' and member_a = a and member_b = b;
  if v_id is null then
    insert into public.channels (tenant_id, kind, member_a, member_b, name) values (app.my_tenant(), 'direct', a, b, 'Direct')
    returning id into v_id;
  end if;
  return v_id;
end $$;

-- Area channels for a volunteer are created on demand.
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
  loop
    insert into public.channels (tenant_id, kind, area_code, name)
    values (me.tenant_id, lvl, code, initcap(lvl) || ' ' || code)
    on conflict (tenant_id, kind, area_code) do nothing;
  end loop;
  return query select * from public.channels
    where tenant_id = me.tenant_id and kind in ('state','lga','ward') and me.area_code like area_code || '%';
end $$;

-- ---------------------------------------------------------------------------
-- Live view
-- ---------------------------------------------------------------------------

create or replace function public.request_live_view(p_case uuid, p_agent uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not app.is_supervisor() and app.my_role() <> 'operator' then raise exception 'Not allowed'; end if;
  insert into public.live_view_requests (tenant_id, case_id, requested_by, agent_id, room_name)
  values (app.my_tenant(), p_case, app.my_id(), p_agent, 'lv-' || replace(gen_random_uuid()::text, '-', ''))
  returning id into v_id;
  insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
  values (app.my_tenant(), 'push', p_agent, 'live_view_request', jsonb_build_object('request_id', v_id, 'case_id', p_case));
  if p_case is not null then perform app.case_event(p_case, 'live_view_requested', null, jsonb_build_object('request_id', v_id)); end if;
  return v_id;
end $$;

create or replace function public.answer_live_view(p_id uuid, p_accept boolean, p_mode text default 'live') returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.live_view_requests set status = case when p_accept then 'accepted' else 'declined' end,
         mode = case when p_accept then p_mode end
   where id = p_id and agent_id = app.my_id() and status = 'requested';
  if not found then raise exception 'Unknown request'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- Top-ups (two-person approval, caps)
-- ---------------------------------------------------------------------------

create or replace function public.create_topup_batch(p_plan uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  p public.topup_plans;
  v_id uuid;
  v_cap int;
begin
  if not app.is_admin() then raise exception 'Only admins can create top-up batches'; end if;
  select * into p from public.topup_plans where id = p_plan and tenant_id = app.my_tenant();
  if not found then raise exception 'Unknown plan'; end if;
  v_cap := app.setting_int(p.tenant_id, 'topup_per_person_cap_ngn', 5000);
  insert into public.topup_batches (tenant_id, plan_id, created_by) values (p.tenant_id, p.id, app.my_id()) returning id into v_id;
  insert into public.topups (tenant_id, batch_id, plan_id, volunteer_id, phone, network, kind, amount_ngn, idempotency_key)
  select p.tenant_id, v_id, p.id, v.id, v.phone, v.network, p.kind, p.amount_ngn, 'tu-' || p.id || '-' || v.id
    from public.volunteers v
   where v.tenant_id = p.tenant_id and v.status = 'active'
     and v.role = any(p.target_roles)
     and (cardinality(p.target_area_codes) = 0 or exists (select 1 from unnest(p.target_area_codes) a where v.area_code like a || '%'))
     and (not p.onboarded_only or v.onboarded_at is not null)
     and (p.kind = 'airtime' or v.network is not null)
     -- per-person cap across all plans of this tenant
     and coalesce((select sum(t.amount_ngn) from public.topups t
                    where t.volunteer_id = v.id and t.status not in ('failed','cancelled')), 0) + p.amount_ngn <= v_cap
  on conflict (plan_id, volunteer_id) do nothing;
  update public.topup_batches b set person_count = x.n, total_ngn = x.total
    from (select count(*) n, coalesce(sum(amount_ngn), 0) total from public.topups where batch_id = v_id) x
   where b.id = v_id;
  perform app.audit(p.tenant_id, 'topup_batch_created', 'topup_batch', v_id::text);
  return v_id;
end $$;

create or replace function public.approve_topup_batch(p_batch uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  b public.topup_batches;
  v_daily bigint;
  v_today bigint;
begin
  if not app.is_admin() then raise exception 'Only admins can approve'; end if;
  select * into b from public.topup_batches where id = p_batch and tenant_id = app.my_tenant() for update;
  if not found or b.status <> 'pending_approval' then raise exception 'Batch is not waiting for approval'; end if;
  if b.created_by = app.my_id() then raise exception 'A second admin must approve'; end if;
  if not p_approve then
    update public.topup_batches set status = 'cancelled', approved_by = app.my_id(), approved_at = now() where id = p_batch;
    update public.topups set status = 'cancelled' where batch_id = p_batch;
    return;
  end if;
  v_daily := app.setting_int(b.tenant_id, 'topup_daily_cap_ngn', 50000000);
  select coalesce(sum(total_ngn), 0) into v_today from public.topup_batches
   where tenant_id = b.tenant_id and status in ('approved','sending','done') and approved_at::date = now()::date;
  if v_today + b.total_ngn > v_daily then raise exception 'Daily cap of % NGN would be exceeded', v_daily; end if;
  update public.topup_batches set status = 'approved', approved_by = app.my_id(), approved_at = now() where id = p_batch;
  perform app.audit(b.tenant_id, 'topup_batch_approved', 'topup_batch', p_batch::text, jsonb_build_object('total_ngn', b.total_ngn));
end $$;

-- ---------------------------------------------------------------------------
-- Live results views (stage 1 estimate, stage 2 our EC8A, stage 3 IReV)
-- ---------------------------------------------------------------------------

create or replace view public.v_latest_results with (security_invoker = true) as
select distinct on (tenant_id, election_id, pu_code)
  tenant_id, election_id, pu_code, version, registered, accredited, rejected, total_valid, votes, status, submitted_at
from public.result_submissions
order by tenant_id, election_id, pu_code, version desc;

create or replace view public.v_tally_ec8a with (security_invoker = true) as
select r.tenant_id, r.election_id, left(r.pu_code, 2) as state_code, left(r.pu_code, 5) as lga_code,
       v.key as party, sum(v.value::int) as votes, count(distinct r.pu_code) as units
from public.v_latest_results r, jsonb_each_text(r.votes) v
group by 1, 2, 3, 4, 5;

create or replace view public.v_tally_irev as
select s.election_id, left(s.pu_code, 2) as state_code, left(s.pu_code, 5) as lga_code,
       v.key as party, sum(v.value::int) as votes, count(distinct s.pu_code) as units
from (select distinct on (election_id, pu_code) * from public.irev_sheet_results
       where ocr_status = 'confirmed' or (ocr_status = 'read' and min_confidence >= 0.85)
       order by election_id, pu_code, sheet_version desc) s,
     jsonb_each_text(s.votes) v
group by 1, 2, 3, 4;

create or replace view public.v_quick_tally with (security_invoker = true) as
select q.tenant_id, q.election_id, left(q.pu_code, 2) as state_code, left(q.pu_code, 5) as lga_code,
       v.key as party, sum(v.value::int) as votes, count(distinct q.pu_code) as units
from (select distinct on (tenant_id, election_id, pu_code) * from public.quick_tallies
       order by tenant_id, election_id, pu_code, at desc) q,
     jsonb_each_text(q.votes) v
group by 1, 2, 3, 4, 5;

-- Sample-based estimate per state: vote shares with a 95% margin (simple
-- proportion estimate weighted by unit weight; refined in the worker).
create or replace function public.sample_estimate(p_election uuid) returns table (
  state_code text, party text, share double precision, margin double precision, units_reported int, units_in_sample int)
language sql stable security definer set search_path = public as $$
  with sample as (select * from public.sample_units where tenant_id = app.my_tenant() and election_id = p_election),
  latest as (
    select distinct on (q.pu_code) q.pu_code, q.votes from public.quick_tallies q
     join sample s on s.pu_code = q.pu_code
    where q.tenant_id = app.my_tenant() and q.election_id = p_election
    order by q.pu_code, q.at desc),
  votes as (
    select s.stratum, s.weight, l.pu_code, v.key as party, v.value::int as n,
           sum(v.value::int) over (partition by l.pu_code) as unit_total
      from latest l join sample s on s.pu_code = l.pu_code, jsonb_each_text(l.votes) v),
  shares as (
    select stratum, party, sum(weight * n)::double precision / nullif(sum(weight * unit_total), 0) as p,
           count(distinct pu_code) as k
      from votes group by stratum, party)
  select sh.stratum, sh.party, sh.p,
         1.96 * sqrt(greatest(sh.p * (1 - sh.p), 0) / greatest(sh.k, 1)),
         sh.k::int,
         (select count(*)::int from sample s2 where s2.stratum = sh.stratum)
  from shares sh
$$;
