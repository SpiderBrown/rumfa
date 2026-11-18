-- Premium add-ons per client (tenants.settings.addons), switched on in Rumfa Console: voice (Voice outreach) and
-- airtime (Airtime and data). Off by default. Clients already using one keep it on.
update public.tenants t set settings = coalesce(t.settings, '{}'::jsonb) || jsonb_build_object('addons', jsonb_build_object(
    'voice', exists (select 1 from public.voice_recordings r where r.tenant_id = t.id) or exists (select 1 from public.voice_campaigns c where c.tenant_id = t.id),
    'airtime', exists (select 1 from public.topup_plans p where p.tenant_id = t.id)))
 where t.settings->'addons' is null;
