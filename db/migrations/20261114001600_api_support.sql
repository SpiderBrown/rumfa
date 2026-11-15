-- Helpers the API needs on top of the original schema.

-- Agent codes go into coded SMS and, with the sender's phone, decide which
-- client a message belongs to. A new code must be unused in this tenant and
-- across every client the same phone works for. Answers only yes/no, so
-- nothing about other clients is revealed.
create or replace function public.agent_code_taken(p_phone text, p_code text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.volunteers
     where agent_code = p_code and (phone = p_phone or tenant_id = app.my_tenant())
  )
$$;

-- Messages of a conversation with each sender's name. Agents cannot read
-- other people's records directly, but may see who wrote in a conversation
-- they belong to.
create or replace function public.channel_messages(p_channel uuid, p_limit int default 200)
returns table (id uuid, channel_id uuid, sender_id uuid, sender_name text, kind text, body text, media_path text,
               client_id uuid, sent_at timestamptz, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select m.id, m.channel_id, m.sender_id, v.full_name, m.kind, m.body, m.media_path, m.client_id, m.sent_at, m.created_at
    from public.messages m left join public.volunteers v on v.id = m.sender_id
   where m.channel_id = p_channel and app.can_access_channel(p_channel)
   order by m.created_at desc
   limit least(p_limit, 500)
$$;
