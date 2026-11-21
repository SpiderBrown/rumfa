-- What the worker is doing: each of its tasks records when it last ran, last succeeded and last failed (at most once a
-- minute per task, so this costs next to nothing). Rumfa Console → Background jobs shows it with the queues.
create table public.worker_heartbeats (
  task text primary key,
  every_s int,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  runs bigint not null default 0,
  worker text
);
alter table public.worker_heartbeats enable row level security;
