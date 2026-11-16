-- Senatorial districts (109: three per state, one for the FCT). A Senate election is won per district, so the
-- map and results can group LGAs by district. Loaded from OCHA boundary data by `import:boundaries --level
-- senatorial`, which also links each LGA to the district containing most of its outline (districts follow LGA
-- borders). Codes are the state's code plus the district's number in that state, e.g. 20-SD1.
create table public.senatorial_districts (
  code text primary key check (code ~ '^\d{2}-SD\d$'),
  state_code text not null references public.states(code),
  name text not null,
  irev_id text,                       -- IReV's district id (as on wards.senatorial_district), filled from linked wards
  updated_at timestamptz not null default now()
);
create index on public.senatorial_districts (state_code);

alter table public.senatorial_districts enable row level security;
create policy senatorial_districts_read on public.senatorial_districts for select to rumfa_api using (true);
grant select on public.senatorial_districts to rumfa_api;

alter table public.lgas add column senatorial_code text references public.senatorial_districts(code);
create index on public.lgas (senatorial_code);

-- District outlines live with the other map shapes
alter table public.area_shapes drop constraint area_shapes_level_check;
alter table public.area_shapes add constraint area_shapes_level_check check (level in ('state', 'senatorial', 'lga', 'ward'));
