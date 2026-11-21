-- Ballot papers on IReV sheets: items 3, 4, 5 and 8 of Form EC8A (issued, unused, spoiled, used), as agents
-- already send them with their own result. They are optional (older reviews and unreadable boxes stay empty),
-- and when present they are checked the same way as on the phone (shared figureFlags):
--   used = spoiled + rejected + valid (item 8 = 5 + 6 + 7), and issued = used + unused (item 3 = 8 + 4).
alter table public.irev_sheet_results
  add column if not exists ballots_received int check (ballots_received >= 0),
  add column if not exists unused int check (unused >= 0),
  add column if not exists spoiled int check (spoiled >= 0),
  add column if not exists used int check (used >= 0);

-- The ballot-paper checks, worded like the phone's (shared figureFlags: ballots_unbalanced, used_mismatch)
create or replace function app.ballot_issues(p_received int, p_unused int, p_spoiled int, p_rejected int, p_valid int, p_used int)
returns jsonb language sql immutable as $$
  with c as (select case when p_spoiled is not null and p_rejected is not null and p_valid is not null
                         then p_spoiled + p_rejected + p_valid end as used)
  select coalesce(jsonb_agg(x), '[]'::jsonb) from (
    select jsonb_build_object('code', 'ballots_unbalanced', 'message',
             format('Used (%s) + unused (%s) = %s, but %s ballot papers were issued', c.used, p_unused, c.used + p_unused, p_received)) as x
      from c where c.used is not null and p_unused is not null and p_received is not null and c.used + p_unused <> p_received
    union all
    select jsonb_build_object('code', 'used_mismatch', 'message',
             format('Announced used ballot papers (%s) differ from spoiled + rejected + valid (%s)', p_used, c.used))
      from c where c.used is not null and p_used is not null and p_used <> c.used
  ) q
$$;

-- Confirming a sheet now takes the ballot papers too (all optional, so existing callers still work)
drop function if exists public.confirm_irev_sheet(uuid, text, int, int, int, int, int, jsonb);
create or replace function public.confirm_irev_sheet(
  p_election uuid, p_pu text, p_version int, p_registered int, p_accredited int, p_rejected int, p_total_valid int, p_votes jsonb,
  p_ballots_received int default null, p_unused int default null, p_spoiled int default null, p_used int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if app.my_role() not in ('analyst','supervisor','admin','legal') then raise exception 'Not allowed'; end if;
  update public.irev_sheet_results set registered = p_registered, accredited = p_accredited, rejected = p_rejected,
         total_valid = p_total_valid, votes = p_votes,
         ballots_received = p_ballots_received, unused = p_unused, spoiled = p_spoiled, used = p_used,
         ocr_status = 'confirmed',
         check_issues = app.result_issues(p_registered, p_accredited, p_rejected, p_total_valid, p_votes)
                     || app.ballot_issues(p_ballots_received, p_unused, p_spoiled, p_rejected, p_total_valid, p_used),
         reviewed_by = app.my_id(), reviewed_at = now()
   where election_id = p_election and pu_code = p_pu and sheet_version = p_version;
  update public.irev_availability set ocr_status = 'confirmed' where election_id = p_election and pu_code = p_pu;
  perform app.verify_unit_all_tenants(p_election, p_pu);
end $$;
