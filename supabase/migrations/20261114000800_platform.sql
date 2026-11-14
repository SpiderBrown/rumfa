-- Supabase platform wiring: storage buckets, realtime, scheduled jobs.
-- Each block is guarded so the migrations also run on plain Postgres (tests).

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

    -- Uploads go under the uploader's tenant folder; reads are via signed URLs
    -- issued by the API for the people allowed to see the record.
    execute $p$create policy "tenant uploads" on storage.objects for insert to authenticated
      with check (bucket_id in ('ec8a','incident-media','voice-notes','chat-media','live-clips','voice-recordings')
                  and (storage.foldername(name))[1] = app.my_tenant()::text)$p$;
    execute $p$create policy "tenant reads own folder" on storage.objects for select to authenticated
      using (bucket_id in ('ec8a','incident-media','voice-notes','chat-media','live-clips')
             and (storage.foldername(name))[1] = app.my_tenant()::text
             and (owner = auth.uid() or app.is_room_staff()))$p$;
    execute $p$create policy "staff read irev" on storage.objects for select to authenticated
      using (bucket_id = 'irev' and app.is_room_staff())$p$;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.cases, public.case_events, public.messages, public.callback_requests,
      public.live_view_requests, public.irev_fetch_jobs, public.verifications, public.staff_status;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('alawa-tick-cases', '* * * * *', 'select app.tick_cases()');
    perform cron.schedule('alawa-tick-callbacks', '* * * * *', 'select app.tick_callbacks()');
    perform cron.schedule('alawa-stale-contacts', '0 6 * * *', 'select app.mark_stale_contacts(7)');
  end if;
end $$;
