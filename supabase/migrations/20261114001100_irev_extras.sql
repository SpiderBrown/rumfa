-- Extra IReV fields used by the worker: perceptual hash for duplicate-sheet
-- detection, content type, and the IReV id of each sheet version seen.
alter table public.irev_availability
  add column if not exists phash text,
  add column if not exists content_type text,
  add column if not exists seen_doc_ids text[] not null default '{}';
create index if not exists irev_av_phash on public.irev_availability(election_id, phash) where phash is not null;

-- Baseline (2023) unit shares used by the trend check.
create or replace view public.v_baseline_unit_shares as
select s.election_id, s.pu_code, v.key as party,
       v.value::numeric / nullif(s.total_valid, 0) as share, s.total_valid
from (select distinct on (election_id, pu_code) * from public.irev_sheet_results
       where ocr_status in ('confirmed','read') order by election_id, pu_code, sheet_version desc) s,
     jsonb_each_text(s.votes) v;
