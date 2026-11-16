-- Where a check-in was made relative to the agent's own area. The server judges it against the best outline or
-- position it has (ward, else the unit's own position, else LGA, else state). Check-ins outside need a note from
-- the agent; a later check-in from the right place corrects it, and every check-in is kept.
alter table public.checkins
  add column checked_against text check (checked_against in ('ward', 'unit', 'lga', 'state')),
  add column inside boolean,          -- null: no location, or nothing to compare with
  add column distance_m int,          -- from the area's centre (or the unit)
  add column note text check (length(note) <= 500);
