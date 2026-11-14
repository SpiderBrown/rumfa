-- Supabase Storage buckets (private). Only the NestJS API and worker read and
-- write them, with the service key; apps get short-lived signed links.
-- Live updates use Postgres NOTIFY and timers run in the worker, so Supabase
-- Realtime and pg_cron are not used. Guarded so plain Postgres works too.

do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values
      ('ec8a', 'ec8a', false),             -- agent photos of signed EC8A: {tenant}/{election}/{pu}/{uuid}.jpg
      ('incident-media', 'incident-media', false),
      ('voice-notes', 'voice-notes', false),
      ('chat-media', 'chat-media', false),
      ('live-clips', 'live-clips', false),
      ('irev', 'irev', false),             -- IReV sheets (shared): {election}/{pu}/v{n}.jpg
      ('voice-recordings', 'voice-recordings', false),
      ('contact-imports', 'contact-imports', false)
    on conflict (id) do nothing;

  end if;
end $$;
