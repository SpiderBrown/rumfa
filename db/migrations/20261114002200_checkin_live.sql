-- Check-ins reach the situation room's Check-ins page as they happen.
create trigger checkins_live after insert on public.checkins
  for each row execute function app.notify_change('id', 'tenant_id', 'pu_code');
