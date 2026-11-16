-- Geopolitical zones on the map: each zone's outline is its states merged into one (saved by
-- `import:boundaries --level state`, code Z-NC, Z-NE, Z-NW, Z-SE, Z-SS, Z-SW). Zones themselves are states.zone.
alter table public.area_shapes drop constraint area_shapes_level_check;
alter table public.area_shapes add constraint area_shapes_level_check check (level in ('zone', 'state', 'senatorial', 'lga', 'ward'));
