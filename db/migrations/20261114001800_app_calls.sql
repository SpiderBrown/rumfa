-- App calls: free voice calls over the internet between two people using the Rumfa apps (agent app or
-- dashboard), through LiveKit. They are rows in public.calls with route = 'inapp'. Ringing, answering
-- and hanging up are announced live to the two people on the call (see the Socket.IO gateway).
create trigger calls_live after insert or update on public.calls
  for each row when (new.route = 'inapp')
  execute function app.notify_change('id', 'tenant_id', 'caller_id', 'callee_id', 'status');

create index if not exists calls_inapp_open on public.calls (callee_id, status) where route = 'inapp';
