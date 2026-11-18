-- Ogun: IReV spells it Sagamu, the OCHA outline file Shagamu.
insert into public.place_name_aliases (level, from_key, to_key, from_name, to_name) values
  ('lga', 'sagamu', 'shagamu', 'Sagamu', 'Shagamu')
on conflict (level, from_key) do nothing;
