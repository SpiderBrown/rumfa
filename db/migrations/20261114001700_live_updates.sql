-- Live updates. Changes to the rows the apps watch are announced on the
-- `rumfa_changes` channel. Every API instance listens and forwards each event
-- only to the connections allowed to know about it (see the Socket.IO
-- gateway). Events carry ids and routing fields, never record contents: the
-- apps re-read through the API, which applies the usual checks.
create or replace function app.notify_change() returns trigger language plpgsql as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  payload jsonb := jsonb_build_object('t', tg_table_name, 'op', lower(tg_op));
  k text;
begin
  foreach k in array tg_argv loop
    payload := payload || jsonb_build_object(k, r -> k);
  end loop;
  perform pg_notify('rumfa_changes', payload::text);
  return null;
end $$;

create trigger cases_live after insert or update on public.cases
  for each row execute function app.notify_change('id', 'tenant_id', 'area_code', 'assigned_to', 'status');
create trigger case_events_live after insert on public.case_events
  for each row execute function app.notify_change('id', 'tenant_id', 'case_id');
create trigger messages_live after insert on public.messages
  for each row execute function app.notify_change('id', 'tenant_id', 'channel_id');
create trigger callbacks_live after insert or update on public.callback_requests
  for each row execute function app.notify_change('id', 'tenant_id', 'requester_id', 'assigned_to', 'status');
create trigger live_view_live after insert or update on public.live_view_requests
  for each row execute function app.notify_change('id', 'tenant_id', 'case_id', 'agent_id', 'requested_by', 'status');
create trigger irev_jobs_live after insert or update on public.irev_fetch_jobs
  for each row execute function app.notify_change('id', 'tenant_id', 'status');
create trigger verifications_live after insert or update on public.verifications
  for each row execute function app.notify_change('tenant_id', 'election_id', 'pu_code', 'status');
create trigger staff_status_live after insert or update on public.staff_status
  for each row execute function app.notify_change('volunteer_id', 'tenant_id', 'status');
