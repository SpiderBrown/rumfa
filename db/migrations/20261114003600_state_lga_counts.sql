-- Each state's official number of LGAs (774 in all), so a state only partly loaded from IReV (a load cut short)
-- shows as needing attention and "Only what's missing" loads its places again.
alter table public.states add column if not exists lga_count int;
update public.states s set lga_count = x.n from (values
  ('01',17), ('02',21), ('03',31), ('04',21), ('05',20), ('06',8), ('07',23), ('08',27), ('09',18), ('10',25),
  ('11',13), ('12',18), ('13',16), ('14',17), ('15',11), ('16',27), ('17',27), ('18',23), ('19',44), ('20',34),
  ('21',21), ('22',21), ('23',16), ('24',20), ('25',13), ('26',25), ('27',20), ('28',18), ('29',30), ('30',33),
  ('31',17), ('32',23), ('33',23), ('34',16), ('35',17), ('36',14), ('37',6)
) as x(code, n) where s.code = x.code;
