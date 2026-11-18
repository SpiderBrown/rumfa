-- Rumfa support access: an owner or staff member signs in on any client's dashboard with their console account and
-- picks the client to open, as an admin, to test or fix something. They work through a membership row of their own
-- in that client, marked with platform_staff_id: hidden from the client's people lists, never on a phone, and every
-- entry is in the console's activity log.
alter table public.volunteers add column platform_staff_id uuid references public.platform_staff(id) on delete cascade;
alter table public.volunteers alter column phone drop not null;
alter table public.volunteers add constraint volunteers_phone_required check (phone is not null or platform_staff_id is not null);
create unique index volunteers_platform_staff on public.volunteers (tenant_id, platform_staff_id) where platform_staff_id is not null;
