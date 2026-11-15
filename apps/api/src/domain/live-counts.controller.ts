import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, Matches, Max, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { elections } from '../common/fn';
import { ROOM } from './roles';
import { childLength, inScope, mapScope } from './map.controller';

const MAX_PER_UNIT = 5000; // no polling unit has more registered voters than this

class LiveCountDto {
  @ApiProperty({ example: '19-28-02-003' }) @Matches(/^\d{2}-\d{2}-\d{2}-\d{3}$/) pu: string;
  @ApiProperty({ description: 'Increases with every change on the phone; older messages are ignored' }) @IsInt() @Min(1) seq: number;
  @ApiProperty({ example: { APC: 41, PDP: 37 } }) @IsObject() counts: Record<string, number>;
  @ApiProperty() @IsInt() @Min(0) @Max(MAX_PER_UNIT) invalid: number;
  @ApiPropertyOptional({ description: 'Sorting finished at this unit' }) @IsOptional() @IsBoolean() done?: boolean;
}

/**
 * Live count during ballot sorting: the agent taps a party each time its name is called; the phone sends
 * the running totals. The situation room sees totals for any state, LGA or ward while counting goes on.
 */
@ApiTags('Live count')
@ApiBearerAuth()
@Controller('live-counts')
export class LiveCountsController {
  constructor(private readonly db: Db) {}

  @Post() @HttpCode(200) @Roles('agent')
  @ApiOperation({ summary: 'Running totals from the agent at the unit (send the latest; repeats and old messages are ignored)' })
  async update(@CurrentUser() u: AuthUser, @Body() d: LiveCountDto) {
    if (u.level !== 'pu' || u.area !== d.pu) throw new ForbiddenException('You can only count at your own polling unit');
    const election = await this.liveElection(u);
    const parties: string[] = (await this.db.system(`select party from public.election_parties where election_id = $1`, [election])).map((p) => p.party);
    const counts: Record<string, number> = {};
    for (const [p, n] of Object.entries(d.counts ?? {})) {
      if (!parties.includes(p)) throw new BadRequestException(`${p} is not on this ballot`);
      if (!Number.isInteger(n) || n < 0 || n > MAX_PER_UNIT) throw new BadRequestException(`Count for ${p} is not valid`);
      if (n > 0) counts[p] = n;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0) + d.invalid;
    if (total > MAX_PER_UNIT) throw new BadRequestException('More ballots than any unit has voters');
    const status = d.done ? 'done' : 'counting';
    const [row] = await this.db.system(
      `insert into public.live_counts (tenant_id, election_id, pu_code, volunteer_id, counts, invalid, total, seq, status, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, case when $9 = 'done' then now() end)
       on conflict (tenant_id, election_id, pu_code) do update set
         volunteer_id = excluded.volunteer_id, counts = excluded.counts, invalid = excluded.invalid, total = excluded.total,
         seq = excluded.seq, status = excluded.status, updated_at = now(),
         finished_at = case when excluded.status = 'done' then coalesce(live_counts.finished_at, now()) end
       where live_counts.seq < excluded.seq
       returning id, seq, status`,
      [u.tid, election, d.pu, u.mid, JSON.stringify(counts), d.invalid, total, d.seq, status]);
    if (!row) {
      // An older or repeated message: tell the phone what the server already has
      const [cur] = await this.db.system(`select seq, status from public.live_counts where tenant_id = $1 and election_id = $2 and pu_code = $3`, [u.tid, election, d.pu]);
      return { seq: cur?.seq ?? 0, status: cur?.status ?? 'counting', stale: true };
    }
    if (status === 'done') {
      // The finished count also serves as the unit's quick count (sample estimate); one per live count
      await this.db.system(
        `insert into public.quick_tallies (tenant_id, election_id, volunteer_id, pu_code, votes, client_id)
         values ($1, $2, $3, $4, $5, $6) on conflict (client_id) do update set votes = excluded.votes, at = now()`,
        [u.tid, election, u.mid, d.pu, JSON.stringify(counts), row.id]);
    }
    return { seq: row.seq, status: row.status };
  }

  @Get('mine') @Roles('agent')
  @ApiOperation({ summary: "This agent's count at their unit (to carry on after reinstalling the app)" })
  async mine(@CurrentUser() u: AuthUser) {
    const election = await this.liveElection(u);
    const [row] = await this.db.system(
      `select counts, invalid, total, seq, status, started_at, updated_at from public.live_counts where tenant_id = $1 and election_id = $2 and pu_code = $3`,
      [u.tid, election, u.area]);
    return row ?? null;
  }

  @Get('summary') @Roles(...ROOM, 'coordinator')
  @ApiOperation({ summary: 'Running totals for an area (default: yours) and each of its sub-areas' })
  async summary(@CurrentUser() u: AuthUser, @Query('area') areaQ?: string) {
    const scope = mapScope(u);
    const area = (areaQ || scope).trim();
    if (!/^(NG|\d{2}(-\d{2}){0,3})$/.test(area)) throw new BadRequestException('Unknown area');
    if (!inScope(scope, area)) throw new ForbiddenException('That area is outside yours');
    const election = await this.liveElection(u);
    const len = childLength(area); // null for a single polling unit
    const prefix = area === 'NG' ? '%' : area.length === 12 ? area : `${area}-%`;

    const rows = await this.db.system(
      `select pu_code, counts, invalid, total, status, updated_at from public.live_counts
        where tenant_id = $1 and election_id = $2 and pu_code like $3`, [u.tid, election, prefix]);
    const [units] = await this.db.system(
      `select count(*)::int as units, count(*) filter (where exists (select 1 from public.volunteers v where v.tenant_id = $1 and v.role = 'agent'
                and v.status in ('invited','active') and v.area_code = p.code))::int as with_agent
         from public.polling_units p where p.code like $2`, [u.tid, prefix]);
    const parties: string[] = (await this.db.system(`select party from public.election_parties where election_id = $1 order by ballot_order`, [election])).map((p) => p.party);

    const add = (acc: Agg, r: any) => {
      acc.units++; if (r.status === 'done') acc.done++; else acc.counting++;
      acc.invalid += r.invalid; acc.ballots += r.total;
      for (const [p, n] of Object.entries<number>(r.counts)) acc.votes[p] = (acc.votes[p] ?? 0) + n;
      if (!acc.updatedAt || r.updated_at > acc.updatedAt) acc.updatedAt = r.updated_at;
    };
    const totals = agg();
    const byChild = new Map<string, Agg>();
    for (const r of rows) {
      add(totals, r);
      if (len) { const k = r.pu_code.slice(0, len); if (!byChild.has(k)) byChild.set(k, agg()); add(byChild.get(k)!, r); }
    }

    let children: any[] = [];
    if (len) {
      const kidsSql = { 2: `select code, name from public.states`, 5: `select code, name from public.lgas where state_code = $1`,
        8: `select code, name from public.wards where lga_code = $1`, 12: `select code, name from public.polling_units where ward_code = $1` }[len]!;
      const kids = await this.db.system(kidsSql, len === 2 ? [] : [area]);
      children = kids.map((k) => ({ code: k.code, name: k.name, ...(byChild.get(k.code) ?? agg()) }))
        .filter((c) => len === 12 || c.units > 0 || area !== 'NG');
    }
    return { area, scope, election, parties, ...totals, unitsInArea: units.units, unitsWithAgent: units.with_agent,
      breadcrumb: await this.breadcrumb(scope, area), childLevel: len ? ({ 2: 'state', 5: 'lga', 8: 'ward', 12: 'pu' } as any)[len] : null, children };
  }

  private async liveElection(u: AuthUser): Promise<string> {
    const { live } = await this.db.asUser(u, (q) => elections(q, u.tid));
    if (!live) throw new BadRequestException('No election is set up yet');
    return live;
  }

  private async breadcrumb(scope: string, area: string) {
    const parts = area === 'NG' ? [] : area.split('-');
    const chain = parts.map((_, i) => parts.slice(0, i + 1).join('-')).filter((c) => inScope(scope, c));
    const codes = [...(scope === 'NG' ? ['NG'] : []), ...chain];
    const names = await this.db.system(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1) union all select code, name from public.polling_units where code = any($1)`, [codes]);
    return codes.map((code) => ({ code, name: code === 'NG' ? 'Nigeria' : names.find((n) => n.code === code)?.name ?? code }));
  }
}

interface Agg { units: number; counting: number; done: number; ballots: number; invalid: number; votes: Record<string, number>; updatedAt: string | null }
const agg = (): Agg => ({ units: 0, counting: 0, done: 0, ballots: 0, invalid: 0, votes: {}, updatedAt: null });
