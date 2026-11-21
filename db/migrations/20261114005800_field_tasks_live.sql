-- Live: the coordinator's app hears about new and changed tasks
drop trigger if exists field_tasks_live on public.field_tasks;
create trigger field_tasks_live after insert or update on public.field_tasks
  for each row execute function app.notify_change('id', 'tenant_id', 'assignee_id', 'status');
