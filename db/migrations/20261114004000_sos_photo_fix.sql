-- Fix: adding a photo after an SOS failed ("malformed array literal"): the words added to the case note were joined
-- with || to a text array, which reads an untyped string as an array. array_append adds it as one item.
create or replace function public.add_incident_details(
  p_client_id uuid, p_category text default null, p_note text default null, p_media text[] default '{}', p_mistake boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  i public.incidents;
  c public.cases;
  v_cat public.incident_categories;
  v_said text[] := '{}';
begin
  select * into i from public.incidents where client_id = p_client_id and volunteer_id = app.my_id() for update;
  if not found then raise exception 'Unknown report'; end if;
  select * into c from public.cases where id = i.case_id for update;

  if p_mistake then
    -- Sent by mistake: the room still sees it (and may check), but it is no longer an emergency
    update public.incidents set is_sos = false, severity = 'low',
           description = concat_ws(E'\n', nullif(description, ''), 'The agent says this was sent by mistake.') where id = i.id;
    if c.id is not null then
      if c.report_count <= 1 and c.status in ('queued', 'assigned') then
        update public.cases set status = 'closed', severity = 'low', closed_at = now(), outcome = 'Sent by mistake (the reporter cancelled it)' where id = c.id;
      end if;
      perform app.case_event(c.id, 'note', 'The agent says the SOS was sent by mistake.', jsonb_build_object('incident_id', i.id, 'mistake', true));
    end if;
    return jsonb_build_object('incident_id', i.id, 'case_id', c.id);
  end if;

  if p_category is not null then
    select * into v_cat from public.incident_categories where code = p_category and not is_alert;
    if not found then raise exception 'Unknown category %', p_category; end if;
    -- What the emergency is: replaces the general "Emergency (SOS)", and names the case if it was opened by it
    if i.category = 'sos' then
      update public.incidents set category = p_category where id = i.id;
      if c.id is not null and c.category = 'sos' then
        update public.cases set category = p_category, title = v_cat.label || ' at ' || i.pu_code where id = c.id;
      end if;
    end if;
    v_said := array_append(v_said, v_cat.label);
  end if;
  if nullif(trim(p_note), '') is not null then
    update public.incidents set description = concat_ws(E'\n', nullif(description, ''), trim(p_note)) where id = i.id;
    v_said := array_append(v_said, trim(p_note));
  end if;
  if coalesce(array_length(p_media, 1), 0) > 0 then
    update public.incidents set media_paths = media_paths || p_media where id = i.id;
    v_said := array_append(v_said, 'a photo');
  end if;
  if c.id is not null and array_length(v_said, 1) > 0 then
    perform app.case_event(c.id, 'note', 'The agent added: ' || array_to_string(v_said, ' · '), jsonb_build_object('incident_id', i.id, 'media', p_media));
  end if;
  return jsonb_build_object('incident_id', i.id, 'case_id', c.id);
end $$;
