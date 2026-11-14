-- Grants for rumfa_api (user requests through the NestJS API) and the
-- Supabase lockdown. Keep this migration last; later migrations that add
-- tables or functions get the same treatment from the default privileges.

grant select, insert, update, delete on all tables in schema public to rumfa_api;
grant usage, select on all sequences in schema public to rumfa_api;
alter default privileges in schema public grant select, insert, update, delete on tables to rumfa_api;
alter default privileges in schema public grant usage, select on sequences to rumfa_api;

-- Credentials and sign-in records are never reachable from a user request.
revoke all on public.identities, public.auth_devices, public.otp_challenges, public.activation_codes,
  public.staff_invites, public.refresh_tokens, public.rate_limits from rumfa_api;

-- Functions: nobody by default; rumfa_api for everything except the
-- service-only entry points (svc_*), which only the owner (API system
-- context and worker) may call.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname, n.nspname
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public','app') and p.prokind = 'f'
              and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e') loop
    execute format('revoke all on function %s from public', f.sig);
    if f.proname not like 'svc\_%' then
      execute format('grant execute on function %s to rumfa_api', f.sig);
    end if;
  end loop;
end $$;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema app revoke execute on functions from public;
alter default privileges in schema public grant execute on functions to rumfa_api;
alter default privileges in schema app grant execute on functions to rumfa_api;
-- Sign-in helpers stay owner-only even so.
revoke all on function app.link_identity(uuid) from rumfa_api;
revoke all on function app.rate_hit(text, int, interval) from rumfa_api;

-- Supabase lockdown: its Data API roles get nothing. (On Supabase also remove
-- `public` from the exposed schemas and disable sign-ups; see README.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    revoke all on all functions in schema app from anon, authenticated;
    revoke usage on schema app from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end $$;
