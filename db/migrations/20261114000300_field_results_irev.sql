-- Field operations, results, verification and IReV data.

create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  volunteer_id uuid not null references public.volunteers(id),
  pu_code text not null references public.polling_units(code),
  lat double precision, lng double precision, accuracy_m double precision,
  client_id uuid unique,
  at timestamptz not null default now()
);
create index on public.checkins(tenant_id, election_id, pu_code);

create table public.checklist_responses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  volunteer_id uuid not null references public.volunteers(id),
  pu_code text not null references public.polling_units(code),
  item_code text not null,
  answer jsonb not null,
  client_id uuid unique,
  at timestamptz not null default now(),
  unique (election_id, volunteer_id, item_code)
);

create table public.quick_tallies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  volunteer_id uuid not null references public.volunteers(id),
  pu_code text not null references public.polling_units(code),
  votes jsonb not null,          -- {"APC": 120, "PDP": 40}
  is_sample boolean not null default false,   -- part of the ~1,500 unit sample
  client_id uuid unique,
  at timestamptz not null default now()
);
create index on public.quick_tallies(tenant_id, election_id, pu_code, at desc);

-- Units chosen for the statistical sample (stage 1 estimate).
create table public.sample_units (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  stratum text not null,          -- e.g. state code
  weight double precision not null default 1,
  primary key (tenant_id, election_id, pu_code)
);

create table public.result_submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  volunteer_id uuid not null references public.volunteers(id),
  pu_code text not null references public.polling_units(code),
  version int not null default 1,
  source text not null check (source in ('app','sms')),
  registered int not null, accredited int not null, rejected int not null, total_valid int not null,
  votes jsonb not null,
  check_issues jsonb not null default '[]',
  sheet_photo_path text,                -- storage path of the signed EC8A photo
  status text not null default 'synced' check (status in ('synced','verified','flagged')),
  client_id uuid unique,
  submitted_at timestamptz not null default now(),
  unique (tenant_id, election_id, pu_code, version)
);
create index on public.result_submissions(tenant_id, election_id, pu_code, version desc);

-- OCR of either an agent photo or an IReV sheet.
create table public.ocr_extractions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),          -- null for IReV (shared)
  election_id uuid not null references public.elections(id),
  pu_code text not null,
  source text not null check (source in ('agent_photo','irev')),
  submission_id uuid references public.result_submissions(id) on delete cascade,
  sheet_version int,
  sheet_pu_code text,                 -- unit code printed on the sheet
  serial_no text,
  figures jsonb,                      -- ResultFigures
  confidence jsonb,                   -- per-field confidence 0..1
  min_confidence double precision,
  provider text,
  created_at timestamptz not null default now()
);
create index on public.ocr_extractions(election_id, pu_code, source);

create table public.verifications (
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  status text not null check (status in ('pending','verified','mismatch','agent_only','irev_only')),
  agent_figures jsonb, agent_ocr_figures jsonb, irev_figures jsonb,
  sources_agreeing int not null default 0,
  diff text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (tenant_id, election_id, pu_code)
);

-- IReV (public, shared between tenants) -------------------------------------
create table public.irev_availability (
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  status text not null default 'not_checked'
    check (status in ('not_checked','not_on_irev','on_irev','downloaded','replaced','failed')),
  ocr_status text not null default 'not_read'
    check (ocr_status in ('not_read','read','needs_review','confirmed')),
  irev_doc_id text,
  document_url text, backup_url text, thumb_url text,
  storage_path text, size_bytes int, checksum text,
  irev_updated_at timestamptz,
  first_seen_at timestamptz,
  last_checked_at timestamptz,
  replaced_count int not null default 0,
  attempts int not null default 0,
  last_error text,
  primary key (election_id, pu_code)
);
create index on public.irev_availability(election_id, status);
create index on public.irev_availability(checksum) where checksum is not null;

create table public.irev_check_log (
  id bigint generated always as identity primary key,
  election_id uuid not null,
  pu_code text not null,
  status text not null,
  detail jsonb,
  at timestamptz not null default now()
);
create index on public.irev_check_log(election_id, pu_code, at desc);

create table public.irev_fetch_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  election_id uuid not null references public.elections(id),
  job_type text not null check (job_type in ('baseline','live','ocr','recheck')),
  area_level text not null check (area_level in ('national','state','lga','ward')),
  area_code text not null,
  auto_recheck boolean not null default false,
  interval_min int not null default 10,
  status text not null default 'queued' check (status in ('queued','running','paused','done','failed','cancelled')),
  counts jsonb not null default '{}',
  error text,
  requested_by uuid references public.volunteers(id),
  created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz, next_run_at timestamptz
);
create index on public.irev_fetch_jobs(status, next_run_at);

create table public.irev_sheet_results (
  election_id uuid not null references public.elections(id),
  pu_code text not null references public.polling_units(code),
  sheet_version int not null default 1,
  registered int, accredited int, rejected int, total_valid int,
  votes jsonb not null default '{}',
  confidence jsonb,
  min_confidence double precision,
  sheet_pu_code text,
  ocr_status text not null check (ocr_status in ('read','needs_review','confirmed')),
  check_issues jsonb not null default '[]',
  reviewed_by uuid references public.volunteers(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (election_id, pu_code, sheet_version)
);
