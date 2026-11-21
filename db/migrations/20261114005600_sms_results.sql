-- Results by SMS (no data network): the coded SMS leaves out parties with 0 votes so it fits in one text; here every
-- party on the ballot is filled in with 0, so the SMS and the app's copy of the same sheet are recognised as one
-- (the app's copy, sent later when there is data, adds the photo and its id: full-resolution photo requests then work).
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
  v_votes jsonb := coalesce(p_votes, '{}');
begin
  if p_client_id is not null then
    select id into v_id from public.result_submissions where client_id = p_client_id;
    if found then
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

  -- Every party on the ballot, 0 where not given (SMS leaves zeros out)
  select coalesce(jsonb_object_agg(ep.party, coalesce((v_votes->>ep.party)::int, 0)), '{}'::jsonb) || v_votes into v_votes
    from public.election_parties ep where ep.election_id = v_election;

  -- Same figures already received by another channel (SMS vs app): merge, don't add a version
  select id into v_id from public.result_submissions
   where tenant_id = v.tenant_id and election_id = v_election and pu_code = p_pu
     and registered = p_registered and accredited = p_accredited and rejected = p_rejected
     and total_valid = p_total_valid and votes = v_votes
   order by version desc limit 1;
  if v_id is not null then
    update public.result_submissions set sheet_photo_path = coalesce(sheet_photo_path, p_photo), client_id = coalesce(client_id, p_client_id)
     where id = v_id;
    return jsonb_build_object('submission_id', v_id, 'duplicate', true);
  end if;

  select coalesce(max(version), 0) + 1 into v_version from public.result_submissions
   where tenant_id = v.tenant_id and election_id = v_election and pu_code = p_pu;
  v_issues := app.result_issues(p_registered, p_accredited, p_rejected, p_total_valid, v_votes);

  insert into public.result_submissions (tenant_id, election_id, volunteer_id, pu_code, version, source,
    registered, accredited, rejected, total_valid, votes, check_issues, sheet_photo_path, client_id)
  values (v.tenant_id, v_election, v.id, p_pu, v_version, p_source,
    p_registered, p_accredited, p_rejected, p_total_valid, v_votes, v_issues, p_photo, p_client_id)
  returning id into v_id;

  perform app.verify_unit(v.tenant_id, v_election, p_pu);
  return jsonb_build_object('submission_id', v_id, 'version', v_version, 'issues', v_issues, 'duplicate', false);
end $$;
