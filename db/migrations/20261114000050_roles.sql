-- Database roles.
-- The NestJS API logs in as the schema owner (on Supabase: the Session pooler
-- user) and, for every signed-in user's request, switches to rumfa_api with
-- SET LOCAL ROLE inside a transaction, after setting app.user_id and
-- app.tenant_id. rumfa_api cannot bypass row-level security, so the policies
-- in the rls migration act as a backstop behind the API's own checks.
-- System work (webhooks, the worker, sign-in) runs as the owner.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'rumfa_api') then
    create role rumfa_api nologin nobypassrls;
  end if;
end $$;
grant rumfa_api to current_user;

create schema if not exists app;
grant usage on schema public, app to rumfa_api;
