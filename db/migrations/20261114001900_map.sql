-- Situation-room map. Area outlines (states, LGAs, wards) as simplified GeoJSON, loaded from open
-- boundary data by `import:boundaries` (see apps/api/src/scripts/import-boundaries.ts). Reference
-- data shared by all tenants, like the geography tables. Polling units are points
-- (polling_units.lat/lng, or where agents checked in).
create table public.area_shapes (
  code text primary key,
  level text not null check (level in ('state','lga','ward')),
  geometry jsonb not null,              -- GeoJSON Polygon or MultiPolygon
  center_lat double precision,
  center_lng double precision,
  source text,
  updated_at timestamptz not null default now()
);
create index on public.area_shapes(level);

alter table public.area_shapes enable row level security;
create policy area_shapes_read on public.area_shapes for select to rumfa_api using (true);
grant select on public.area_shapes to rumfa_api;

-- Map colours per party (optional): tenants.settings.party_colours, e.g. {"APC": "#1b7a3a"}.
