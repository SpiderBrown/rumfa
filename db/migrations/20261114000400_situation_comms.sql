-- Situation room (incidents, alerts, cases), authority contacts,
-- communications, voice outreach and top-ups.

create table public.incident_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  ward_code text not null,
  category text not null references public.incident_categories(code),
  confirmed_by uuid references public.volunteers(id),
  created_at timestamptz not null default now()
);

create table public.cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid references public.elections(id),
  queue_id uuid references public.queues(id),
  pu_code text references public.polling_units(code),
  area_code text not null,                 -- pu code, or ward/LGA/state code for wider cases
  category text not null references public.incident_categories(code),
  severity text not null check (severity in ('critical','high','medium','low')),
  status text not null default 'queued'
    check (status in ('queued','assigned','in_progress','escalated','resolved','closed','merged')),
  source text not null default 'incident' check (source in ('incident','alert','callback','operator')),
  title text not null,
  report_count int not null default 0,
  reporter_count int not null default 0,
  assigned_to uuid references public.volunteers(id),
  last_operator uuid references public.volunteers(id),
  escalation_level int not null default 0,
  ack_due_at timestamptz,
  due_at timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  closed_by uuid references public.volunteers(id),
  outcome text,
  merged_into uuid references public.cases(id),
  incident_group_id uuid references public.incident_groups(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.cases(tenant_id, status, queue_id);
create index on public.cases(tenant_id, pu_code, category, status);
create index on public.cases(tenant_id, area_code text_pattern_ops);
create index on public.cases(assigned_to) where status in ('assigned','in_progress');
create trigger cases_touch before update on public.cases for each row execute function app.touch_updated_at();

create table public.incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid references public.elections(id),
  volunteer_id uuid references public.volunteers(id),
  pu_code text not null references public.polling_units(code),
  category text not null references public.incident_categories(code),
  severity text not null check (severity in ('critical','high','medium','low')),
  is_sos boolean not null default false,
  description text,
  media_paths text[] not null default '{}',
  source text not null default 'app' check (source in ('app','sms','call','operator')),
  case_id uuid references public.cases(id),
  client_id uuid unique,
  reported_at timestamptz not null default now()
);
create index on public.incidents(case_id);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid references public.elections(id),
  rule text not null references public.incident_categories(code),
  severity text not null,
  pu_code text references public.polling_units(code),
  area_code text not null,
  details jsonb not null default '{}',
  dedupe_key text,
  case_id uuid references public.cases(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create table public.case_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id),
  case_id uuid not null references public.cases(id) on delete cascade,
  kind text not null,          -- created, report_merged, assigned, acknowledged, note, call, escalated, resolved, closed, reopened, merged, unmerged, severity_changed, task_sent, suggestion
  actor_id uuid references public.volunteers(id),
  body text,
  data jsonb not null default '{}',
  at timestamptz not null default now()
);
create index on public.case_events(case_id, at);

create table public.case_merges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  case_id uuid not null references public.cases(id),          -- the case that received
  source_case_id uuid references public.cases(id),            -- manual merge of a whole case
  incident_id uuid references public.incidents(id),           -- automatic merge of a report
  kind text not null check (kind in ('auto','suggested','manual')),
  merged_by uuid references public.volunteers(id),            -- null = system
  moved_incident_ids uuid[] not null default '{}',            -- for undoing a manual merge
  moved_alert_ids uuid[] not null default '{}',
  undone boolean not null default false,
  at timestamptz not null default now()
);

create table public.case_suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  case_id uuid not null references public.cases(id) on delete cascade,
  related_case_id uuid not null references public.cases(id) on delete cascade,
  reason text not null check (reason in ('same_ward_category','same_unit_related')),
  status text not null default 'open' check (status in ('open','accepted','dismissed')),
  decided_by uuid references public.volunteers(id),
  created_at timestamptz not null default now(),
  unique (case_id, related_case_id)
);

-- Authority contacts ----------------------------------------------------------
create table public.authority_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),      -- null = official (shared)
  agency text not null,                              -- INEC, Police, Army, NSCDC, DSS, Party legal, ...
  title text not null,                               -- e.g. Electoral Officer, DPO, Control room
  person_name text,
  phone text,
  email text,
  address text,
  level text not null check (level in ('national','state','lga','ward')),
  area_code text not null,
  status text not null default 'pending'
    check (status in ('draft','pending','call_tested','verified','rejected','stale')),
  source_type text not null check (source_type in ('official','liaison','coordinator')),
  source_url text,
  fetched_at timestamptz,
  external_key text,                  -- idempotent import key
  imported_by uuid references public.volunteers(id),
  added_by uuid references public.volunteers(id),
  approved_by uuid references public.volunteers(id),
  approved_at timestamptz,
  last_call_ok_at timestamptz,
  last_call_failed_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, external_key)
);
create index on public.authority_contacts(area_code text_pattern_ops);
create trigger contacts_touch before update on public.authority_contacts for each row execute function app.touch_updated_at();

-- Calls (click-to-call, bridged callbacks, in-app) ------------------------------
create table public.callback_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid references public.elections(id),
  requester_id uuid not null references public.volunteers(id),
  reason text not null check (reason in ('form','unit','app','other')),
  voice_note_path text,
  channel text not null default 'app' check (channel in ('app','sms')),
  status text not null default 'waiting'
    check (status in ('waiting','calling','done','no_answer','escalated','closed','cancelled','case_opened')),
  assigned_to uuid references public.volunteers(id),
  escalation_level int not null default 0,       -- 0 ward coord, 1 deputy, 2 LGA coord, 3 state room
  attempts int not null default 0,
  due_at timestamptz not null,
  outcome text,
  case_id uuid references public.cases(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index callback_one_open on public.callback_requests(requester_id)
  where status in ('waiting','calling','no_answer','escalated');
create index on public.callback_requests(assigned_to, status);
create trigger callbacks_touch before update on public.callback_requests for each row execute function app.touch_updated_at();

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  case_id uuid references public.cases(id),
  callback_id uuid references public.callback_requests(id),
  contact_id uuid references public.authority_contacts(id),
  caller_id uuid references public.volunteers(id),
  callee_id uuid references public.volunteers(id),
  to_phone text,
  direction text not null default 'outbound' check (direction in ('outbound','inbound')),
  route text not null check (route in ('webrtc_pstn','bridged','inapp','gsm_direct')),
  video boolean not null default false,
  status text not null default 'initiated'
    check (status in ('initiated','ringing','answered','completed','no_answer','failed','busy')),
  reason text,
  provider_session_id text unique,
  duration_s int,
  recording_url text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index on public.calls(case_id);

-- Messaging --------------------------------------------------------------------
create table public.channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  kind text not null check (kind in ('case','ward','lga','state','direct')),
  area_code text,
  case_id uuid unique references public.cases(id) on delete cascade,
  member_a uuid references public.volunteers(id),
  member_b uuid references public.volunteers(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, kind, area_code),
  check (kind <> 'direct' or (member_a is not null and member_b is not null and member_a < member_b))
);
create unique index channels_direct_unique on public.channels(tenant_id, member_a, member_b) where kind = 'direct';

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  channel_id uuid not null references public.channels(id) on delete cascade,
  sender_id uuid references public.volunteers(id),
  kind text not null default 'text' check (kind in ('text','voice','photo','video','system')),
  body text,
  media_path text,
  client_id uuid unique,
  sent_at timestamptz not null default now(),       -- time on the phone (may be earlier when offline)
  created_at timestamptz not null default now()
);
create index on public.messages(channel_id, created_at);

create table public.channel_reads (
  channel_id uuid not null references public.channels(id) on delete cascade,
  volunteer_id uuid not null references public.volunteers(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, volunteer_id)
);

create table public.live_view_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  case_id uuid references public.cases(id),
  requested_by uuid not null references public.volunteers(id),
  agent_id uuid not null references public.volunteers(id),
  status text not null default 'requested'
    check (status in ('requested','accepted','declined','live','clip_uploaded','ended','expired')),
  mode text check (mode in ('live','clip')),
  room_name text unique,
  media_path text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);

-- Notifications outbox (push, SMS, WhatsApp) processed by the worker.
create table public.outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id),
  channel text not null check (channel in ('push','sms','whatsapp')),
  to_volunteer uuid references public.volunteers(id),
  to_phone text,
  template text not null,
  data jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','sent','failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index on public.outbox(status, created_at);

-- Inbound SMS log (results, incidents and callbacks by SMS fallback).
create table public.sms_inbound (
  id uuid primary key default gen_random_uuid(),
  provider_id text unique,
  from_phone text not null,
  to_number text,
  text text not null,
  decoded jsonb,
  error text,
  tenant_id uuid references public.tenants(id),
  volunteer_id uuid references public.volunteers(id),
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Voice outreach ---------------------------------------------------------------
create table public.voice_recordings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  speaker text not null,
  title text not null,
  language text not null,
  storage_path text not null,
  duration_s int,
  consent_doc_path text not null,          -- signed release from the speaker
  status text not null default 'draft' check (status in ('draft','approved','retired')),
  approved_by uuid references public.volunteers(id),
  approved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.voice_contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  phone text not null,
  language text not null default 'ha',
  state_code text, lga_code text,
  source text not null,                     -- e.g. 'volunteer_referral', 'event_signup'
  consent_basis text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, phone)
);

create table public.voice_campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  recordings jsonb not null,                -- {"ha": "<recording id>", "en": "..."}
  audience jsonb not null default '{}',     -- {"states": ["20"], "lgas": [], "languages": ["ha"]}
  starts_on date not null, ends_on date not null,
  daily_start time not null default '09:00', daily_end time not null default '19:00',
  max_attempts int not null default 2,
  calls_per_minute int not null default 60,
  status text not null default 'draft' check (status in ('draft','approved','running','paused','done')),
  created_by uuid references public.volunteers(id),
  approved_by uuid references public.volunteers(id),
  created_at timestamptz not null default now()
);

create table public.voice_call_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  campaign_id uuid not null references public.voice_campaigns(id) on delete cascade,
  contact_id uuid not null references public.voice_contacts(id) on delete cascade,
  attempt int not null,
  status text not null default 'queued' check (status in ('queued','dialing','answered','completed','no_answer','busy','failed','opted_out')),
  provider_session_id text unique,
  duration_s int,
  dtmf text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, contact_id, attempt)
);
create index on public.voice_call_attempts(campaign_id, status);

-- Airtime and data top-ups -------------------------------------------------------
create table public.topup_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  kind text not null check (kind in ('airtime','data')),
  amount_ngn int not null check (amount_ngn > 0),
  data_plan_code text,                      -- provider's bundle code when kind = 'data'
  target_roles text[] not null,
  target_area_codes text[] not null default '{}',   -- empty = whole coverage
  onboarded_only boolean not null default true,
  scheduled_for timestamptz,
  created_by uuid references public.volunteers(id),
  created_at timestamptz not null default now()
);

create table public.topup_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  plan_id uuid not null references public.topup_plans(id),
  status text not null default 'pending_approval'
    check (status in ('pending_approval','approved','sending','done','cancelled')),
  person_count int not null default 0,
  total_ngn bigint not null default 0,
  created_by uuid not null references public.volunteers(id),
  approved_by uuid references public.volunteers(id),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  check (approved_by is null or approved_by <> created_by)
);

create table public.topups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  batch_id uuid not null references public.topup_batches(id),
  plan_id uuid not null references public.topup_plans(id),
  volunteer_id uuid not null references public.volunteers(id),
  phone text not null,
  network text,
  kind text not null,
  amount_ngn int not null,
  status text not null default 'queued' check (status in ('queued','sending','pending','success','failed','cancelled')),
  provider text,
  provider_ref text,
  idempotency_key text not null unique,
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, volunteer_id)
);
create index on public.topups(status);
