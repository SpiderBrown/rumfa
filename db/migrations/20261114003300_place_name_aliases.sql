-- Name matches for outline files: a place's name in Rumfa (from IReV) and how a boundary file spells it, e.g.
-- "Mopa Moro" → "Mopa-Muro". Added in Rumfa Console; used with the built-in ones when outlines are loaded. Keys are
-- normalised names (lower case, letters and digits only), as the matcher compares them.
create table public.place_name_aliases (
  level text not null check (level in ('state', 'lga', 'ward')),
  from_key text not null check (from_key ~ '^[a-z0-9]+$'),   -- Rumfa's name, normalised
  to_key text not null check (to_key ~ '^[a-z0-9]+$'),       -- the file's name, normalised
  from_name text not null,
  to_name text not null,
  created_at timestamptz not null default now(),
  primary key (level, from_key)
);
alter table public.place_name_aliases enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rumfa_api') then
    revoke all on public.place_name_aliases from rumfa_api;
  end if;
end $$;
