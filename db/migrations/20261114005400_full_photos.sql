-- Full-resolution EC8A photos. The agent app sends a light copy of the sheet photo (fast on weak networks) and keeps
-- the full-resolution original on the phone. When the room needs it (a hard-to-read photo, or a dispute), it asks:
-- the app uploads the original. An agent who reports that IReV differs from their sheet is asked automatically.
alter table public.result_submissions add column full_photo_path text;
alter table public.result_submissions add column full_photo_requested_at timestamptz;

-- The room asks for the original of a submitted sheet photo
create or replace function app.request_full_photo(p_submission uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.result_submissions;
begin
  select * into s from public.result_submissions where id = p_submission;
  if not found or s.full_photo_path is not null or s.client_id is null then return; end if;
  update public.result_submissions set full_photo_requested_at = now() where id = p_submission and full_photo_requested_at is null;
  if found then
    insert into public.outbox (tenant_id, channel, to_volunteer, template, data)
    values (s.tenant_id, 'push', s.volunteer_id, 'full_photo_request', jsonb_build_object('submission_id', s.id, 'pu', s.pu_code));
  end if;
end $$;

-- An agent's "IReV is different" also asks for the original of their latest sheet photo
create or replace function app.full_photo_on_dispute() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if new.status = 'differs' and (old.status is distinct from 'differs') then
    select id into v_id from public.result_submissions
     where tenant_id = new.tenant_id and election_id = new.election_id and pu_code = new.pu_code and volunteer_id = new.volunteer_id
     order by version desc limit 1;
    if v_id is not null then perform app.request_full_photo(v_id); end if;
  end if;
  return new;
end $$;
create trigger irev_unit_checks_full_photo after update on public.irev_unit_checks
  for each row execute function app.full_photo_on_dispute();
