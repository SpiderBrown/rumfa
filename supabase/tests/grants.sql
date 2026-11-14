-- Supabase applies these default grants; replicate for local tests.
grant usage on schema public to authenticated, anon, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;
grant execute on all functions in schema public to authenticated, service_role;
-- ...but service-only entry points stay private (as the migration intends on Supabase)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'svc\_%' loop
    execute format('revoke execute on function %s from authenticated, anon, public', f.sig);
  end loop;
end $$;
