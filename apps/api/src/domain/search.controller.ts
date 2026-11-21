import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { placeName } from '../shared';
import { ROOM } from './roles';
import { withCasePlaces } from './case-places';

/** The Room's search box: cases, people and places (polling units, wards, LGAs, states) by name, code or phone. */
@ApiTags('Search')
@ApiBearerAuth()
@Controller('search')
export class SearchController {
  constructor(private readonly db: Db) {}

  @Get() @Roles(...ROOM)
  @ApiOperation({ summary: 'Up to 6 each of cases, people and places matching the words' })
  async search(@CurrentUser() u: AuthUser, @Query('q') raw = '') {
    const q = raw.trim().slice(0, 60);
    if (q.length < 2) return { cases: [], people: [], places: [] };
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const code = /^\d{2}(-\d{2}){0,2}(-\d{3})?$/.test(q) ? q : null;
    const digits = q.replace(/\D/g, '');
    const [cases, people] = await this.db.asUser(u, async (x) => [
      // Cases: by problem, place code, or the place's name (open first, newest first)
      await x(
        `select c.id, c.title, c.category, c.severity, c.status, c.pu_code, c.area_code, c.created_at from public.cases c
          left join public.polling_units p on p.code = c.pu_code left join public.incident_categories ic on ic.code = c.category
          where c.tenant_id = $1 and (c.title ilike $2 or ic.label ilike $2 or p.name ilike $2 or ($3::text is not null and c.area_code like $3 || '%'))
          order by (c.status in ('resolved','closed','merged')), c.created_at desc limit 6`, [u.tid, like, code]),
      await x(
        `select id, full_name, role, level, area_code, phone from public.volunteers
          where tenant_id = $1 and status <> 'removed' and platform_staff_id is null
            and (full_name ilike $2 or ($3 <> '' and length($3) >= 4 and phone like '%' || $3 || '%') or ($4::text is not null and area_code like $4 || '%'))
          order by full_name limit 6`, [u.tid, like, digits, code]),
    ]);
    const places = await this.db.system<{ code: string; name: string; level: string; parent: string | null }>(
      `(select code, name, 'pu' as level, (select name from public.wards w where w.code = left(p.code, 8)) as parent from public.polling_units p
          where ($2::text is not null and code = $2) or name ilike $1 limit 4)
       union all (select code, name, 'ward', (select name from public.lgas l where l.code = left(w.code, 5)) from public.wards w where ($2::text is not null and code = $2) or name ilike $1 limit 3)
       union all (select code, name, 'lga', (select name from public.states s where s.code = l.state_code) from public.lgas l where ($2::text is not null and code = $2) or name ilike $1 limit 3)
       union all (select code, name, 'state', null from public.states where ($2::text is not null and code = $2) or name ilike $1 limit 2)`, [like, code]);
    return {
      cases: (await withCasePlaces(this.db, cases)).map((c) => ({ id: c.id, what: c.what ?? c.title, where: c.where?.name ?? c.pu_code ?? c.area_code, severity: c.severity, status: c.status })),
      people,
      places: places.map((p) => ({ ...p, name: placeName(p.name), parent: p.parent ? placeName(p.parent) : null })),
    };
  }
}
