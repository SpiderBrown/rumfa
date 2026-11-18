-- A client could get the same national-level queue twice (e.g. two "Security desk"): the unique rule on
-- (tenant, kind, state_code) treats an empty state_code as always different. Each set of duplicates is merged
-- into one (the one holding the most cases, then the oldest): its cases and shifts move over, the others go.
-- A unique index that counts an empty state as one value stops it happening again.
with ranked as (
  select q.id, first_value(q.id) over (partition by q.tenant_id, q.kind, coalesce(q.state_code, '')
           order by (select count(*) from public.cases c where c.queue_id = q.id) desc, q.id) as keep
    from public.queues q
), moves as (select id, keep from ranked where id <> keep),
  c as (update public.cases set queue_id = m.keep from moves m where cases.queue_id = m.id returning 1),
  s as (update public.shifts set queue_id = m.keep from moves m where shifts.queue_id = m.id returning 1)
delete from public.queues q using moves m where q.id = m.id;

create unique index if not exists queues_one_per_kind_and_state on public.queues (tenant_id, kind, coalesce(state_code, ''));
