-- States (INEC codes), parties, and the elections the platform knows about.
-- LGAs, wards and polling units are loaded by worker/src/scripts/import-geography.ts
-- from IReV, because there are ~176,000 units.

insert into public.states (code, name, zone, irev_state_no, is_north) values
  ('01','Abia','SE',2,false), ('02','Adamawa','NE',3,true), ('03','Akwa Ibom','SS',4,false),
  ('04','Anambra','SE',5,false), ('05','Bauchi','NE',6,true), ('06','Bayelsa','SS',7,false),
  ('07','Benue','NC',8,true), ('08','Borno','NE',9,true), ('09','Cross River','SS',10,false),
  ('10','Delta','SS',11,false), ('11','Ebonyi','SE',12,false), ('12','Edo','SS',13,false),
  ('13','Ekiti','SW',14,false), ('14','Enugu','SE',15,false), ('15','Gombe','NE',16,true),
  ('16','Imo','SE',17,false), ('17','Jigawa','NW',18,true), ('18','Kaduna','NW',19,true),
  ('19','Kano','NW',20,true), ('20','Katsina','NW',21,true), ('21','Kebbi','NW',22,true),
  ('22','Kogi','NC',23,true), ('23','Kwara','NC',24,true), ('24','Lagos','SW',25,false),
  ('25','Nasarawa','NC',26,true), ('26','Niger','NC',27,true), ('27','Ogun','SW',28,false),
  ('28','Ondo','SW',29,false), ('29','Osun','SW',30,false), ('30','Oyo','SW',31,false),
  ('31','Plateau','NC',32,true), ('32','Rivers','SS',33,false), ('33','Sokoto','NW',34,true),
  ('34','Taraba','NE',35,true), ('35','Yobe','NE',36,true), ('36','Zamfara','NW',37,true),
  ('37','Federal Capital Territory','NC',38,true)
on conflict (code) do nothing;
-- irev_state_no = INEC code + 1 matches the samples checked (Kaduna 19, Kano 20,
-- Rivers 33); the geography import verifies every state by name.

insert into public.parties (acronym, name) values
  ('A','Accord'), ('AA','Action Alliance'), ('AAC','African Action Congress'),
  ('ADC','African Democratic Congress'), ('ADP','Action Democratic Party'),
  ('APC','All Progressives Congress'), ('APGA','All Progressives Grand Alliance'),
  ('APM','Allied Peoples Movement'), ('APP','Action Peoples Party'), ('BP','Boot Party'),
  ('LP','Labour Party'), ('NNPP','New Nigeria Peoples Party'), ('NRM','National Rescue Movement'),
  ('PDP','Peoples Democratic Party'), ('PRP','Peoples Redemption Party'), ('SDP','Social Democratic Party'),
  ('YPP','Young Progressives Party'), ('ZLP','Zenith Labour Party')
on conflict (acronym) do nothing;

insert into public.elections (id, name, election_type, election_date, irev_election_id, status) values
  ('2023b000-0000-4000-8000-000000000001', '2023 Presidential (baseline)', 'presidential', '2023-02-25', '63f8f25b594e164f8146a213', 'closed'),
  ('2027a000-0000-4000-8000-000000000001', '2027 Presidential', 'presidential', '2027-01-16', null, 'upcoming')
on conflict (id) do nothing;

insert into public.election_parties (election_id, party, ballot_order)
select '2023b000-0000-4000-8000-000000000001', acronym, row_number() over (order by acronym) from public.parties
on conflict do nothing;
-- 2027 ballot parties are added once INEC publishes the final list.
