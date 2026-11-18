-- Constituencies: federal (House of Representatives, 360) and state (State House of Assembly, 993). A Reps or
-- Assembly client covers one. Loaded from IReV (Rumfa Console → Places → Load constituencies); wards already carry
-- IReV's constituency numbers (wards.federal_constituency / state_constituency), which link them.
-- Codes are the state's code plus FC/SC and IReV's number, e.g. 19-FC164, 19-SC489.
create table public.constituencies (
  code text primary key check (code ~ '^\d{2}-(FC|SC)\d+$'),
  kind text not null check (kind in ('federal', 'state')),
  state_code text not null references public.states(code),
  name text not null,
  irev_no int not null,                 -- matches wards.federal_constituency / state_constituency
  irev_code text,                       -- IReV's own label, e.g. fc/166/kn
  updated_at timestamptz not null default now(),
  unique (kind, irev_no)
);
create index on public.constituencies (state_code);
alter table public.constituencies enable row level security;
create policy constituencies_read on public.constituencies for select to rumfa_api using (true);
grant select on public.constituencies to rumfa_api;

-- Wards of a constituency (by IReV's number); used for coverage and pickers
create index on public.wards (federal_constituency);
create index on public.wards (state_constituency);
