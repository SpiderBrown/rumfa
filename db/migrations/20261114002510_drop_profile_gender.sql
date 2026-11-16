-- A gender column was briefly added to volunteers during development (and applied to one database) before the
-- decision not to collect gender. Remove it wherever it exists; a no-op everywhere else.
alter table public.volunteers drop column if exists gender;
