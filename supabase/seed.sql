-- Development seed: one tenant, a small piece of Kano geography, room queues,
-- and a set of people for each role. Never run in production.

insert into public.lgas (code, state_code, name) values ('19-28','19','Dev LGA A'), ('19-29','19','Dev LGA B') on conflict do nothing;
insert into public.wards (code, lga_code, name) values
  ('19-28-01','19-28','Dev Ward 1'), ('19-28-02','19-28','Dev Ward 2'), ('19-29-01','19-29','Dev Ward 3')
on conflict do nothing;
insert into public.polling_units (code, ward_code, name, registered_voters)
select w.code || '-' || lpad(n::text, 3, '0'), w.code, 'Unit ' || n, 400 + n * 23
  from public.wards w, generate_series(1, 6) n
 where w.code like '19-%'
on conflict do nothing;

insert into public.tenants (id, name) values ('a1a1a1a1-0000-4000-8000-000000000001', 'ALAWA (dev)') on conflict do nothing;
-- Short name shown to the client's people in the apps and at the start of every SMS
update public.tenants set settings = settings || '{"brand": "ALAWA"}' where id = 'a1a1a1a1-0000-4000-8000-000000000001';
insert into public.tenant_coverage values ('a1a1a1a1-0000-4000-8000-000000000001', 'national', 'NG') on conflict do nothing;
insert into public.tenant_elections values
  ('a1a1a1a1-0000-4000-8000-000000000001', '2027a000-0000-4000-8000-000000000001', 'live'),
  ('a1a1a1a1-0000-4000-8000-000000000001', '2023b000-0000-4000-8000-000000000001', 'baseline')
on conflict do nothing;
insert into public.election_parties (election_id, party, ballot_order) values
  ('2027a000-0000-4000-8000-000000000001','APC',1), ('2027a000-0000-4000-8000-000000000001','PDP',2),
  ('2027a000-0000-4000-8000-000000000001','LP',3), ('2027a000-0000-4000-8000-000000000001','NNPP',4),
  ('2027a000-0000-4000-8000-000000000001','ADC',5)
on conflict do nothing;

insert into public.queues (tenant_id, kind, state_code, name) values
  ('a1a1a1a1-0000-4000-8000-000000000001','national',null,'National room'),
  ('a1a1a1a1-0000-4000-8000-000000000001','security',null,'Security desk'),
  ('a1a1a1a1-0000-4000-8000-000000000001','legal',null,'Legal desk'),
  ('a1a1a1a1-0000-4000-8000-000000000001','helpdesk',null,'Agent helpdesk'),
  ('a1a1a1a1-0000-4000-8000-000000000001','state','19','Kano room')
on conflict do nothing;

-- People (phones are fictitious test numbers)
insert into public.volunteers (id, tenant_id, full_name, phone, role, level, area_code, agent_code, languages, network, status, onboarded_at) values
  ('b0000000-0000-4000-8000-000000000001','a1a1a1a1-0000-4000-8000-000000000001','Admin One','+2348000000001','admin','national','NG',null,'{en,ha}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000002','a1a1a1a1-0000-4000-8000-000000000001','Admin Two','+2348000000002','admin','national','NG',null,'{en}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000003','a1a1a1a1-0000-4000-8000-000000000001','Supervisor Kano','+2348000000003','supervisor','state','19',null,'{en,ha}','airtel','active',now()),
  ('b0000000-0000-4000-8000-000000000004','a1a1a1a1-0000-4000-8000-000000000001','Operator Hausa','+2348000000004','operator','state','19',null,'{ha,en}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000005','a1a1a1a1-0000-4000-8000-000000000001','Operator English','+2348000000005','operator','state','19',null,'{en}','glo','active',now()),
  ('b0000000-0000-4000-8000-000000000006','a1a1a1a1-0000-4000-8000-000000000001','Analyst','+2348000000006','analyst','national','NG',null,'{en}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000010','a1a1a1a1-0000-4000-8000-000000000001','LGA Coordinator','+2348000000010','coordinator','lga','19-28',null,'{ha}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000011','a1a1a1a1-0000-4000-8000-000000000001','Ward Coordinator','+2348000000011','coordinator','ward','19-28-02',null,'{ha}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000020','a1a1a1a1-0000-4000-8000-000000000001','Agent 003','+2348000000020','agent','pu','19-28-02-003','7F3','{ha}','mtn','active',now()),
  ('b0000000-0000-4000-8000-000000000021','a1a1a1a1-0000-4000-8000-000000000001','Agent 004','+2348000000021','agent','pu','19-28-02-004','7F4','{en}','airtel','active',now()),
  ('b0000000-0000-4000-8000-000000000022','a1a1a1a1-0000-4000-8000-000000000001','Volunteer 003','+2348000000022','volunteer','pu','19-28-02-003',null,'{ha}','glo','active',now())
on conflict do nothing;
update public.volunteers set deputy_of = null;
insert into public.volunteers (id, tenant_id, full_name, phone, role, level, area_code, deputy_of, languages, status, onboarded_at) values
  ('b0000000-0000-4000-8000-000000000012','a1a1a1a1-0000-4000-8000-000000000001','Ward Deputy','+2348000000012','coordinator','ward','19-28-02','b0000000-0000-4000-8000-000000000011','{ha}','active',now())
on conflict do nothing;

-- Shifts for room staff covering the next 24 hours
insert into public.shifts (tenant_id, volunteer_id, queue_id, starts_at, ends_at, role)
select v.tenant_id, v.id, q.id, now() - interval '1 hour', now() + interval '23 hours',
       case v.role when 'supervisor' then 'supervisor' else 'operator' end
  from public.volunteers v
  join public.queues q on q.tenant_id = v.tenant_id and q.kind = 'state' and q.state_code = '19'
 where v.role in ('operator','supervisor');
insert into public.staff_status (volunteer_id, tenant_id, status)
select id, tenant_id, 'available' from public.volunteers where role in ('operator','supervisor')
on conflict do nothing;
