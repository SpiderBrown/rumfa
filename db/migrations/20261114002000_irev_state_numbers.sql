-- IReV numbers states alphabetically with the FCT in 15th place (Abia 1 … Enugu 14, FCT 15, Gombe 16 …
-- Zamfara 37), checked against IReV's own unit codes. The reference data had every state as INEC code + 1,
-- which fetched the wrong state for Abia–Enugu and the FCT.
update public.states set irev_state_no = case
  when code = '37' then 15
  when code::int <= 14 then code::int
  else code::int + 1 end;
