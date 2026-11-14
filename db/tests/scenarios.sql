-- Scenario tests for the case engine, results, callbacks, contacts, top-ups
-- and row-level security. Each block raises an exception on failure.

create schema if not exists t;
create or replace function t.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is not true then raise exception 'FAILED: %', msg; end if; end $$;
grant usage on schema t to rumfa_api;
grant execute on function t.ok(boolean, text) to rumfa_api;

-- Activation links identities to memberships by phone
insert into public.identities (phone) select distinct phone from public.volunteers;
select app.link_identity(id) from public.identities;
select t.ok((select count(*) from public.volunteers where user_id is null) = 0, 'all volunteers linked to logins');

create or replace function t.act_as(p_volunteer uuid) returns void language plpgsql as $$
begin
  -- What the API does for each request: the signed-in identity and its tenant
  perform set_config('app.user_id', (select user_id::text from public.volunteers where id = p_volunteer), false);
  perform set_config('app.tenant_id', (select tenant_id::text from public.volunteers where id = p_volunteer), false);
end $$;

-- Handy ids
\set tenant '''a1a1a1a1-0000-4000-8000-000000000001'''
\set admin1 '''b0000000-0000-4000-8000-000000000001'''
\set admin2 '''b0000000-0000-4000-8000-000000000002'''
\set sup '''b0000000-0000-4000-8000-000000000003'''
\set op_ha '''b0000000-0000-4000-8000-000000000004'''
\set op_en '''b0000000-0000-4000-8000-000000000005'''
\set lga_coord '''b0000000-0000-4000-8000-000000000010'''
\set ward_coord '''b0000000-0000-4000-8000-000000000011'''
\set ward_deputy '''b0000000-0000-4000-8000-000000000012'''
\set agent3 '''b0000000-0000-4000-8000-000000000020'''
\set agent4 '''b0000000-0000-4000-8000-000000000021'''
\set vol3 '''b0000000-0000-4000-8000-000000000022'''
\set analyst_id '''b0000000-0000-4000-8000-000000000006'''

-- 1. Agent reports BVAS failure: new case, routed to Kano room, auto-assigned
--    to the Hausa-speaking operator (language match), channel created.
select t.act_as(:agent3); set role rumfa_api;
select (public.report_incident('19-28-02-003', 'bvas_failure', null, 'BVAS will not power on', '{}', 'c0000000-0000-4000-8000-000000000001')->>'case_id') as case1 \gset
reset role;
select t.ok((select status from public.cases where id = :'case1') = 'assigned', 'high case auto-assigned');
select t.ok((select assigned_to from public.cases where id = :'case1') = :op_ha, 'assigned to operator sharing reporter language');
select t.ok((select q.kind || q.state_code from public.cases c join public.queues q on q.id = c.queue_id where c.id = :'case1') = 'state19', 'routed to Kano room');
select t.ok(exists (select 1 from public.channels where case_id = :'case1'), 'case chat channel created');

-- Same client_id again (offline resend) is idempotent
select t.act_as(:agent3); set role rumfa_api;
select t.ok((public.report_incident('19-28-02-003', 'bvas_failure', null, 'resend', '{}', 'c0000000-0000-4000-8000-000000000001')->>'duplicate')::boolean, 'resend is a duplicate');
reset role;

-- 2. Another reporter at the same unit and category: merged, counts go up
select t.act_as(:vol3); set role rumfa_api;
select (public.report_incident('19-28-02-003', 'bvas_failure', null, 'Same here')->>'case_id') as case1b \gset
reset role;
select t.ok(:'case1' = :'case1b', 'second report merged into the same case');
select t.ok((select report_count = 2 and reporter_count = 2 from public.cases where id = :'case1'), 'case shows 2 reports from 2 people');

-- 3. Different category at the same unit: never merged automatically
select t.act_as(:agent3); set role rumfa_api;
select (public.report_incident('19-28-02-003', 'voters_turned_away')->>'case_id') as case_vt \gset
reset role;
select t.ok(:'case_vt' <> :'case1', 'different category opens a separate case');
select t.ok(exists (select 1 from public.case_suggestions where case_id = :'case_vt' and related_case_id = :'case1' and reason = 'same_unit_related'),
  'related category at same unit suggested to supervisor');

-- 4. Same category in a neighbouring unit of the same ward: suggested link
select t.act_as(:agent4); set role rumfa_api;
select (public.report_incident('19-28-02-004', 'bvas_failure')->>'case_id') as case4 \gset
reset role;
select t.ok(exists (select 1 from public.case_suggestions where case_id = :'case4' and related_case_id = :'case1' and reason = 'same_ward_category'),
  'same category in same ward suggested');

-- 5. SOS is critical and goes to the security queue
select t.act_as(:agent3); set role rumfa_api;
select (public.report_incident('19-28-02-003', 'violence', null, 'Gunshots', '{}', null, true)->>'case_id') as case_sos \gset
reset role;
select t.ok((select severity = 'critical' from public.cases where id = :'case_sos'), 'SOS is critical');
select t.ok((select q.kind from public.cases c join public.queues q on q.id = c.queue_id where c.id = :'case_sos') = 'security', 'violence goes to security queue');

-- 6. RLS: another agent cannot see the case; the operator can
select t.act_as(:agent4); set role rumfa_api;
select t.ok((select count(*) from public.cases where id = :'case1') = 0, 'agent of another unit cannot see the case');
reset role;
select t.act_as(:op_en); set role rumfa_api;
select t.ok((select count(*) from public.cases where id = :'case1') = 1, 'room staff see the case');
reset role;

-- 7. Operator works and resolves the case; it closes (not critical)
select t.act_as(:op_ha); set role rumfa_api;
select public.acknowledge_case(:'case1');
select public.add_case_note(:'case1', 'Called agent; technician on the way');
select public.resolve_case(:'case1', 'Replacement BVAS delivered');
reset role;
select t.ok((select status from public.cases where id = :'case1') = 'closed', 'non-critical case closes on resolve');

-- 8. A new matching report within 2 hours reopens it and returns it to the last operator
select t.act_as(:vol3); set role rumfa_api;
select (public.report_incident('19-28-02-003', 'bvas_failure', null, 'Failed again')->>'case_id') as case1c \gset
reset role;
select t.ok(:'case1c' = :'case1', 'report reopens the recent case');
select t.ok((select status = 'assigned' and assigned_to = :op_ha from public.cases where id = :'case1'), 'returned to last operator');

-- 9. Supervisor merges and undoes a merge
select t.act_as(:sup); set role rumfa_api;
select public.merge_cases(:'case4', :'case1');
reset role;
select t.ok((select status from public.cases where id = :'case4') = 'merged', 'source case marked merged');
select t.ok((select report_count from public.cases where id = :'case1') = 4, 'reports moved to target');
select t.act_as(:sup); set role rumfa_api;
select public.undo_merge((select id from public.case_merges where source_case_id = :'case4'));
reset role;
select t.ok((select status from public.cases where id = :'case4') = 'queued', 'undo returns source case to queue');
select t.ok((select report_count from public.cases where id = :'case1') = 3, 'reports moved back');

-- Operators cannot merge
select t.act_as(:op_en); set role rumfa_api;
do $$ begin
  perform public.merge_cases('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001');
  raise exception 'FAILED: operator could merge';
exception when others then
  if sqlerrm like 'FAILED%' then raise; end if;
end $$;
reset role;

-- 10. Acknowledgement deadline missed: reassigned to someone else
update public.cases set ack_due_at = now() - interval '1 minute' where id = :'case1';
select app.tick_cases();
select t.ok((select assigned_to <> :op_ha from public.cases where id = :'case1'), 'unacknowledged case reassigned');
select t.ok(exists (select 1 from public.case_events where case_id = :'case1' and kind = 'ack_missed'), 'ack_missed logged');

-- 11. Results: agent submits; then IReV shows different figures -> mismatch alert to legal desk
select t.act_as(:agent3); set role rumfa_api;
select public.submit_result('19-28-02-003', 607, 265, 0, 265, '{"APC":83,"NNPP":149,"PDP":32,"ADP":1}', 'tenant/x.jpg', 'c0000000-0000-4000-8000-0000000000aa');
reset role;
select t.ok((select status from public.verifications where pu_code = '19-28-02-003') = 'agent_only', 'agent only before IReV');
insert into public.irev_sheet_results (election_id, pu_code, sheet_version, registered, accredited, rejected, total_valid, votes, min_confidence, ocr_status)
values ('2027a000-0000-4000-8000-000000000001', '19-28-02-003', 1, 607, 265, 0, 265, '{"APC":83,"NNPP":159,"PDP":22,"ADP":1}', 0.95, 'read');
select app.verify_unit_all_tenants('2027a000-0000-4000-8000-000000000001', '19-28-02-003');
select t.ok((select status from public.verifications where pu_code = '19-28-02-003') = 'mismatch', 'mismatch detected');
select t.ok((select diff from public.verifications where pu_code = '19-28-02-003') = '{votes.NNPP,votes.PDP}', 'diff lists changed parties');
select t.ok(exists (select 1 from public.cases c join public.queues q on q.id = c.queue_id
                     where c.category = 'irev_mismatch' and c.pu_code = '19-28-02-003' and q.kind = 'legal'), 'mismatch case in legal queue');
-- Re-running verification does not duplicate the alert
select app.verify_unit_all_tenants('2027a000-0000-4000-8000-000000000001', '19-28-02-003');
select t.ok((select count(*) from public.alerts where rule = 'irev_mismatch') = 1, 'alert raised once');
-- Bad arithmetic flagged
select t.act_as(:agent4); set role rumfa_api;
select public.submit_result('19-28-02-004', 500, 200, 5, 210, '{"APC":100,"PDP":100}');
reset role;
select t.ok(exists (select 1 from public.alerts where rule = 'arithmetic_fail' and pu_code = '19-28-02-004'), 'arithmetic alert raised');
-- An agent cannot submit for another unit
select t.act_as(:agent4); set role rumfa_api;
do $$ begin
  perform public.submit_result('19-28-02-003', 1, 1, 0, 1, '{"APC":1}');
  raise exception 'FAILED: wrong unit accepted';
exception when others then if sqlerrm like 'FAILED%' then raise; end if;
end $$;
reset role;

-- 12. Callback request escalation: ward coordinator -> deputy -> LGA -> state room
select t.act_as(:agent4); set role rumfa_api;
select (public.request_callback('form')->>'callback_id') as cb \gset
select t.ok((public.request_callback('form')->>'duplicate')::boolean, 'one open request per agent');
reset role;
select t.ok((select assigned_to from public.callback_requests where id = :'cb') = :ward_coord, 'goes to ward coordinator');
update public.callback_requests set due_at = now() - interval '1 second' where id = :'cb';
select app.tick_callbacks();
select t.ok((select assigned_to from public.callback_requests where id = :'cb') = :ward_deputy, 'escalates to deputy');
update public.callback_requests set due_at = now() - interval '1 second' where id = :'cb';
select app.tick_callbacks();
select t.ok((select assigned_to from public.callback_requests where id = :'cb') = :lga_coord, 'escalates to LGA coordinator');
update public.callback_requests set due_at = now() - interval '1 second' where id = :'cb';
select app.tick_callbacks();
select t.ok((select status = 'escalated' and case_id is not null from public.callback_requests where id = :'cb'), 'escalates to state room as a case');

-- Coordinator call flow with no answer, retry, then done
select t.act_as(:agent3); set role rumfa_api;
select (public.request_callback('unit')->>'callback_id') as cb2 \gset
reset role;
select t.act_as(:ward_coord); set role rumfa_api;
select public.start_callback(:'cb2');
select public.complete_callback(:'cb2', false);
reset role;
select t.ok((select status from public.callback_requests where id = :'cb2') = 'no_answer', 'no answer recorded');
select t.act_as(:ward_coord); set role rumfa_api;
select public.start_callback(:'cb2');
select public.complete_callback(:'cb2', true, 'Explained the form');
reset role;
select t.ok((select status = 'done' and attempts = 2 from public.callback_requests where id = :'cb2'), 'retry then done');

-- 13. Authority contacts: add, test call, approval by the level above only
select t.act_as(:ward_coord); set role rumfa_api;
select public.add_authority_contact('Police', 'Divisional Police Officer', 'DPO Dev', '+2348099999999', 'ward', '19-28-02') as contact \gset
select public.mark_contact_call(:'contact', true);
do $$ begin
  perform public.approve_contact((select id from public.authority_contacts where person_name = 'DPO Dev'), true);
  raise exception 'FAILED: self approval';
exception when others then if sqlerrm like 'FAILED%' then raise; end if;
end $$;
reset role;
select t.act_as(:lga_coord); set role rumfa_api;
select public.approve_contact(:'contact', true);
reset role;
select t.ok((select status from public.authority_contacts where id = :'contact') = 'verified', 'approved by LGA coordinator');

-- 14. Top-ups: two-person approval and per-person cap
select t.act_as(:admin1); set role rumfa_api;
insert into public.topup_plans (tenant_id, name, kind, amount_ngn, target_roles, created_by)
values (:tenant, 'Agents airtime', 'airtime', 1000, '{agent}', :admin1) returning id as plan \gset
select public.create_topup_batch(:'plan') as batch \gset
do $$ begin
  perform public.approve_topup_batch((select id from public.topup_batches order by created_at desc limit 1), true);
  raise exception 'FAILED: creator approved own batch';
exception when others then if sqlerrm like 'FAILED%' then raise; end if;
end $$;
reset role;
select t.ok((select person_count = 2 and total_ngn = 2000 from public.topup_batches where id = :'batch'), 'batch has both agents, 2000 NGN');
select t.act_as(:admin2); set role rumfa_api;
select public.approve_topup_batch(:'batch', true);
reset role;
select t.ok((select status from public.topup_batches where id = :'batch') = 'approved', 'second admin approved');

-- 15. Messaging: reporter can post in the case thread; another agent cannot
select t.act_as(:agent3); set role rumfa_api;
insert into public.messages (tenant_id, channel_id, sender_id, body)
values (:tenant, (select id from public.channels where case_id = :'case1'), :agent3, 'Still waiting');
reset role;
select set_config('t.sos_channel', (select id::text from public.channels where case_id = :'case_sos'), false);
select t.act_as(:agent4); set role rumfa_api;
do $$ begin
  insert into public.messages (tenant_id, channel_id, sender_id, body)
  values ('a1a1a1a1-0000-4000-8000-000000000001',
          current_setting('t.sos_channel')::uuid, 'b0000000-0000-4000-8000-000000000021', 'x');
  raise exception 'FAILED: outsider posted';
exception when others then if sqlerrm like 'FAILED%' then raise; end if;
end $$;
select t.ok((select count(*) from public.my_area_channels()) = 3, 'agent gets state, LGA and ward channels');
reset role;

-- 16. Coordinator can add an agent in their ward but not elsewhere
select t.act_as(:ward_coord); set role rumfa_api;
insert into public.volunteers (tenant_id, full_name, phone, role, level, area_code)
values (:tenant, 'New Agent', '+2348000000030', 'agent', 'pu', '19-28-02-005');
do $$ begin
  insert into public.volunteers (tenant_id, full_name, phone, role, level, area_code)
  values ('a1a1a1a1-0000-4000-8000-000000000001', 'Outside', '+2348000000031', 'agent', 'pu', '19-29-01-001');
  raise exception 'FAILED: added outside area';
exception when others then if sqlerrm like 'FAILED%' then raise; end if;
end $$;
reset role;

select 'scenarios passed' as result;

-- 17. Service-only functions are not callable by app users
select t.act_as(:agent3); set role rumfa_api;
do $$ begin
  perform public.svc_tick();
  raise exception 'FAILED: app user called service function';
exception when insufficient_privilege then null;
end $$;
reset role;
select t.ok((public.svc_tick() ? 'escalated'), 'service tick runs');
select 'service api checks passed' as result;

-- 18. Dashboard read APIs
insert into public.irev_availability (election_id, pu_code, status, ocr_status)
values ('2027a000-0000-4000-8000-000000000001', '19-28-02-001', 'downloaded', 'read'),
       ('2027a000-0000-4000-8000-000000000001', '19-28-02-002', 'not_on_irev', 'not_read')
on conflict do nothing;
select t.act_as(:analyst_id); set role rumfa_api;
select t.ok((select units = 12 and downloaded = 1 and not_on_irev = 1 from public.irev_area_summary('2027a000-0000-4000-8000-000000000001', '19') where area_code = '19-28'),
  'IReV summary counts an LGA');
select t.ok((select count(*) from public.irev_area_summary('2027a000-0000-4000-8000-000000000001', '19-28-02')) = 6, 'unit level lists units');
select t.ok((select ec8a_reported = 2 from public.results_overview('2027a000-0000-4000-8000-000000000001') where area_code = '19'), 'results overview');
select t.ok(exists (select 1 from public.live_tallies('2027a000-0000-4000-8000-000000000001') where stage = 'irev' and party = 'NNPP' and votes = 159), 'IReV tally');
reset role;
select t.act_as(:sup); set role rumfa_api;
select t.ok((select count(*) from public.room_staff()) >= 3, 'room staff list');
select t.ok((select count(*) from public.queue_counts()) = 5, 'queue counters');
reset role;
select 'dashboard api checks passed' as result;

-- 19. Two clients, one person: the agent3 phone is also recruited by client B.
--     Each membership sees only its own client's data; the API picks the
--     tenant at sign-in.
insert into public.tenants (id, name, settings) values ('a2a2a2a2-0000-4000-8000-000000000002', 'Client B', '{"brand":"CLB"}') on conflict do nothing;
insert into public.volunteers (id, tenant_id, full_name, phone, role, level, area_code, agent_code, status)
select 'b2000000-0000-4000-8000-000000000020', 'a2a2a2a2-0000-4000-8000-000000000002', 'Agent at B', phone, 'agent', 'pu', '19-28-02-004', 'ZZ9', 'invited'
  from public.volunteers where id = :agent3;
select app.link_identity((select user_id from public.volunteers where id = :agent3));
select t.ok((select user_id from public.volunteers where id = 'b2000000-0000-4000-8000-000000000020')
            = (select user_id from public.volunteers where id = :agent3), 'same identity, two memberships');

-- As agent3 in client A: own cases visible
select t.act_as(:agent3); set role rumfa_api;
select (select count(*) from public.cases) as cases_a \gset
select t.ok((app.me()).id = :agent3, 'membership A selected by tenant');
reset role;
-- Same identity, client B selected: nothing of client A
select set_config('app.user_id', (select user_id::text from public.volunteers where id = :agent3), false);
select set_config('app.tenant_id', 'a2a2a2a2-0000-4000-8000-000000000002', false);
set role rumfa_api;
select t.ok((app.me()).id = 'b2000000-0000-4000-8000-000000000020', 'membership B selected by tenant');
select t.ok((select count(*) from public.cases) = 0, 'client B sees no client A cases');
select t.ok((select count(*) from public.result_submissions) = 0, 'client B sees no client A results');
select t.ok((select count(*) from public.volunteers where tenant_id <> 'a2a2a2a2-0000-4000-8000-000000000002') = 0, 'client B sees no client A people');
-- A forged tenant with no membership sees nothing at all
select set_config('app.tenant_id', 'a3a3a3a3-0000-4000-8000-000000000003', false);
select t.ok((app.me()).id is null and (select count(*) from public.cases) = 0 and (select count(*) from public.volunteers) = 0,
  'tenant without membership sees nothing');
reset role;
select t.ok(:cases_a > 0, 'client A had cases to hide');

-- 20. Credentials and the Supabase Data API roles are locked out
select t.act_as(:admin1); set role rumfa_api;
do $$ begin
  perform 1 from public.identities limit 1;
  raise exception 'FAILED: user request read identities';
exception when insufficient_privilege then null;
end $$;
do $$ begin
  perform app.link_identity(gen_random_uuid());
  raise exception 'FAILED: user request linked an identity';
exception when insufficient_privilege then null;
end $$;
reset role;
set role anon;
do $$ begin
  perform 1 from public.cases limit 1;
  raise exception 'FAILED: anon read cases';
exception when insufficient_privilege then null;
end $$;
reset role;
set role authenticated;
do $$ begin
  perform public.queue_counts();
  raise exception 'FAILED: authenticated called a function';
exception when insufficient_privilege then null;
end $$;
reset role;
select 'isolation and lockdown checks passed' as result;
