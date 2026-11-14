-- ALAWA platform: reference data shared by all tenants (public INEC geography,
-- elections, parties, incident categories).

create schema if not exists app;

-- Geography -----------------------------------------------------------------
-- Codes follow INEC: state '19', LGA '19-28', ward '19-28-02', unit '19-28-02-003'.
create table public.states (
  code text primary key check (code ~ '^\d{2}$'),
  name text not null,
  zone text,                    -- NW, NE, NC, SW, SE, SS
  irev_state_no int,            -- IReV's own state number (differs from INEC code)
  is_north boolean not null default false
);

create table public.lgas (
  code text primary key check (code ~ '^\d{2}-\d{2}$'),
  state_code text not null references public.states(code),
  name text not null,
  irev_id text unique
);
create index on public.lgas(state_code);

create table public.wards (
  code text primary key check (code ~ '^\d{2}-\d{2}-\d{2}$'),
  lga_code text not null references public.lgas(code),
  name text not null,
  irev_id text unique,
  senatorial_district text,
  federal_constituency text,
  state_constituency text
);
create index on public.wards(lga_code);

create table public.polling_units (
  code text primary key check (code ~ '^\d{2}-\d{2}-\d{2}-\d{3}$'),
  ward_code text not null references public.wards(code),
  name text not null,
  registered_voters int,
  irev_id text unique,
  lat double precision,
  lng double precision
);
create index on public.polling_units(ward_code);

-- Elections and parties -----------------------------------------------------
create table public.elections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  election_type text not null check (election_type in
    ('presidential','governorship','senate','reps','state_assembly','chairman','councillor','fct_area_council')),
  election_date date not null,
  irev_election_id text,
  scope_state_code text references public.states(code),   -- null = nationwide
  status text not null default 'upcoming' check (status in ('upcoming','live','collation','closed')),
  created_at timestamptz not null default now()
);

create table public.parties (
  acronym text primary key check (acronym ~ '^[A-Z]{1,8}$'),
  name text not null
);

create table public.election_parties (
  election_id uuid not null references public.elections(id) on delete cascade,
  party text not null references public.parties(acronym),
  ballot_order int,
  primary key (election_id, party)
);

-- Incident and alert categories (mirrors shared/src/index.ts) ----------------
create table public.incident_categories (
  code text primary key,
  sms text unique,
  label text not null,
  severity text not null check (severity in ('critical','high','medium','low')),
  queue_kind text not null check (queue_kind in ('state','security','legal','helpdesk','national')),
  related text[] not null default '{}',
  is_alert boolean not null default false     -- raised by rules, not by people
);

insert into public.incident_categories (code, sms, label, severity, queue_kind, related, is_alert) values
  ('violence','V','Violence or attack','critical','security','{}',false),
  ('ballot_snatching','BS','Ballot box snatching','critical','security','{}',false),
  ('thugs','TH','Thugs or intimidation','high','security','{}',false),
  ('agent_denied','AD','Our agent denied entry','high','legal','{}',false),
  ('vote_buying','VB','Vote buying observed','medium','legal','{}',false),
  ('materials_late','ML','Materials or officials not arrived','medium','state','{bvas_failure,voters_turned_away}',false),
  ('bvas_failure','BF','BVAS not working','high','state','{voters_turned_away,materials_late}',false),
  ('voters_turned_away','VT','Voters turned away','high','state','{bvas_failure}',false),
  ('result_not_posted','RP','Result (EC60E) not posted','medium','legal','{}',false),
  ('result_dispute','RD','Dispute over result sheet','high','legal','{}',false),
  ('upload_failed','UF','Result not uploaded to IReV','medium','legal','{}',false),
  ('app_problem','AP','App or phone problem','low','helpdesk','{}',false),
  ('other','O','Other','medium','state','{}',false),
  -- rule-based alerts
  ('irev_mismatch',null,'Our EC8A differs from IReV','high','legal','{}',true),
  ('wrong_unit_sheet',null,'IReV sheet belongs to another unit','high','legal','{}',true),
  ('duplicate_sheet',null,'Same sheet image used for several units','high','legal','{}',true),
  ('sheet_replaced',null,'IReV sheet replaced after signing','high','legal','{}',true),
  ('no_upload',null,'No IReV upload hours after counting','medium','legal','{}',true),
  ('arithmetic_fail',null,'Sheet fails arithmetic checks','medium','legal','{}',true),
  ('trend_outlier',null,'Result far from baseline trend','medium','legal','{}',true),
  ('callback_unanswered',null,'Agent callback not answered by coordinators','medium','state','{}',true);

-- Opt-outs from voice calls are global: a person who opts out is never called
-- by any campaign on the platform.
create table public.voice_opt_outs (
  phone text primary key,
  opted_out_at timestamptz not null default now(),
  source text not null default 'dtmf'
);
