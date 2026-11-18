import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Injectable, Logger, NotFoundException, OnModuleInit, Param, ParseUUIDPipe,
  Patch, Post, Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { Db } from '../database/db.service';
import { CurrentStaff, Platform } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { normalisePuCode } from '../shared';
import { parseCsv } from '../scripts/csv';
import { audit } from './audit';
import { importGeography } from './geography-import';
import { importConstituencies } from './constituency-import';
import { importBoundaries, type BoundaryLevel } from './boundary-import';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Outline files kept with the API (apps/api/boundaries), in the order they must load: LGAs before senatorial districts. */
const OUTLINE_FILES: { level: BoundaryLevel; file: string; label: string }[] = [
  { level: 'state', file: 'nga_admin1.geojson', label: 'States' },
  { level: 'lga', file: 'nga_admin2.geojson', label: 'LGAs' },
  { level: 'ward', file: 'nga_admin3.geojson', label: 'Wards' },
  { level: 'senatorial', file: 'nga_senatorialdistricts.geojson', label: 'Senatorial districts' },
];
const outlineDir = () => process.env.BOUNDARIES_DIR || resolve(__dirname, '../../boundaries');
import { normName } from '../scripts/geo';

class PlaceUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 120) name?: string;
  @ApiPropertyOptional({ enum: ['NC', 'NE', 'NW', 'SE', 'SS', 'SW'] }) @IsOptional() @IsIn(['NC', 'NE', 'NW', 'SE', 'SS', 'SW']) zone?: string;
  @ApiPropertyOptional({ description: 'IReV\'s own number for the state' }) @IsOptional() @IsInt() @Min(1) @Max(60) irevStateNo?: number;
}
class GeographyJobDto {
  @ApiProperty({ type: [String], description: 'State codes, e.g. ["19", "20"]' }) @IsArray() @ArrayMaxSize(37) @Matches(/^\d{2}$/, { each: true }) states: string[];
  @ApiPropertyOptional({ description: 'LGAs and wards only (quick)' }) @IsOptional() @IsBoolean() noUnits?: boolean;
  @ApiPropertyOptional({ description: 'IReV election to read from (default 2023 presidential)' }) @IsOptional() @Matches(/^[0-9a-f]{24}$/) irevElectionId?: string;
}
class ConstituencyJobDto {
  @ApiPropertyOptional({ type: [String], description: 'State codes; all states when left out' }) @IsOptional() @IsArray() @ArrayMaxSize(37) @Matches(/^\d{2}$/, { each: true }) states?: string[];
}
class AliasDto {
  @ApiProperty({ enum: ['state', 'lga', 'ward'] }) @IsIn(['state', 'lga', 'ward']) level: string;
  @ApiProperty({ description: 'The name in Rumfa (from IReV)' }) @IsString() @Length(1, 120) fromName: string;
  @ApiProperty({ description: 'How the outline file spells it' }) @IsString() @Length(1, 120) toName: string;
}
class StatesJobDto {
  @ApiPropertyOptional({ type: [String], description: 'State codes; every state not ready yet when left out' }) @IsOptional() @IsArray() @ArrayMaxSize(37) @Matches(/^\d{2}$/, { each: true }) states?: string[];
  @ApiPropertyOptional({ enum: ['all', 'missing', 'local'], description: 'all (default): everything again from IReV and the files. missing: only the steps a state does not have yet. local: no IReV at all; outlines and districts rebuilt from the project files for the places already saved' })
  @IsOptional() @IsIn(['all', 'missing', 'local']) mode?: 'all' | 'missing' | 'local';
}
class OutlinesJobDto {
  @ApiPropertyOptional({ description: 'One state code; all states when left out' }) @IsOptional() @Matches(/^\d{2}$/) state?: string;
}
class VotersDto {
  @ApiProperty({ description: 'CSV with a polling unit code column (pu_code or code) and a registered_voters column' }) @IsString() @MaxLength(20_000_000) csv: string;
}

/** Runs console jobs in the background of the API and keeps their progress in public.platform_jobs. */
@Injectable()
export class PlatformJobs implements OnModuleInit {
  private readonly log = new Logger('PlatformJobs');
  constructor(private readonly db: Db) {}

  async onModuleInit() {
    // A job cannot survive an API restart
    await this.db.system(
      `update public.platform_jobs set status = 'failed', error = 'Stopped: the API restarted while it was running. Start it again (nothing is duplicated).', finished_at = now()
        where status = 'running'`).catch(() => undefined);
  }

  async start(kind: string, params: object, by: string, run: (log: (m: string) => void, progress: (p: object) => void) => Promise<object>) {
    // One at a time: they write the same places
    const [running] = await this.db.system(`select id from public.platform_jobs where status = 'running'`);
    if (running) throw new ConflictException('Another load is running; wait for it to finish');
    const [job] = await this.db.system(`insert into public.platform_jobs (kind, params, started_by) values ($1, $2, $3) returning id`, [kind, JSON.stringify(params), by]);
    const id: string = job.id;
    let last = 0;
    const progress = (p: object) => {
      if (Date.now() - last < 2000) return; // at most every 2 s
      last = Date.now();
      void this.db.system(`update public.platform_jobs set progress = $2 where id = $1`, [id, JSON.stringify(p)]).catch(() => undefined);
    };
    // Log lines are written one after another (in order), and all are saved before the job is marked finished
    let written: Promise<unknown> = Promise.resolve();
    const log = (m: string) => {
      written = written.then(() => this.db.system(`update public.platform_jobs set log = log || $2::text where id = $1`, [id, m]).catch(() => undefined));
    };
    void (async () => {
      try {
        const result = await run(log, progress);
        await written;
        await this.db.system(`update public.platform_jobs set status = 'done', progress = $2, finished_at = now() where id = $1`, [id, JSON.stringify(result)]);
      } catch (e) {
        this.log.error(`Job ${kind} failed: ${(e as Error).message}`);
        await written;
        await this.db.system(`update public.platform_jobs set status = 'failed', error = $2, finished_at = now() where id = $1`, [id, (e as Error).message]).catch(() => undefined);
      }
    })();
    return id;
  }
}

/** Rumfa Console: places (states, LGAs, wards, polling units), loading them from IReV, and registered voters. */
@ApiTags('Rumfa Console: places')
@ApiBearerAuth()
@Controller('platform')
@Platform()
export class PlatformPlacesController {
  constructor(private readonly db: Db, private readonly jobs: PlatformJobs) {}

  @Get('places/browse')
  @ApiOperation({ summary: 'An area\'s sub-areas with counts and what is loaded (outlines, IReV ids, voters)' })
  async browse(@Query('parent') parent = 'NG') {
    if (!/^(NG|\d{2}(-\d{2}){0,2})$/.test(parent)) throw new BadRequestException('Unknown area');
    const q = (sql: string, p?: unknown[]) => this.db.system(sql, p);
    let items: any[];
    if (parent === 'NG') {
      items = await this.stateRows();
    } else if (parent.length === 2) {
      items = await q(
        `select l.code, l.name, l.irev_id is not null as on_irev, d.name as district,
                (select count(*) from public.wards w where w.lga_code = l.code)::int as wards,
                (select count(*) from public.polling_units p where p.code like l.code || '-%')::int as units,
                (select count(registered_voters) from public.polling_units p where p.code like l.code || '-%')::int as with_voters,
                exists (select 1 from public.area_shapes sh where sh.code = l.code) as outline
           from public.lgas l left join public.senatorial_districts d on d.code = l.senatorial_code where l.state_code = $1 order by l.name`, [parent]);
    } else if (parent.length === 5) {
      items = await q(
        `select w.code, w.name, w.irev_id is not null as on_irev,
                (select count(*) from public.polling_units p where p.ward_code = w.code)::int as units,
                (select count(registered_voters) from public.polling_units p where p.ward_code = w.code)::int as with_voters,
                exists (select 1 from public.area_shapes sh where sh.code = w.code) as outline
           from public.wards w where w.lga_code = $1 order by w.code`, [parent]);
    } else {
      items = await q(
        `select code, name, irev_id is not null as on_irev, registered_voters, lat is not null as located
           from public.polling_units where ward_code = $1 order by code`, [parent]);
    }
    const chain = parent === 'NG' ? [] : parent.split('-').map((_, i, a) => a.slice(0, i + 1).join('-'));
    const names = chain.length ? await q(
      `select code, name from public.states where code = any($1) union all select code, name from public.lgas where code = any($1)
       union all select code, name from public.wards where code = any($1)`, [chain]) : [];
    return {
      parent, items,
      breadcrumb: [{ code: 'NG', name: 'Nigeria' }, ...chain.map((c) => ({ code: c, name: names.find((n) => n.code === c)?.name ?? c }))],
    };
  }

  /**
   * Every state with what is loaded, and its status: ready (places, units, constituencies, outlines and districts all
   * there), not_loaded (no LGAs yet) or attention (something missing, listed in `issues`).
   */
  private async stateRows() {
    const rows = await this.db.system(
      `with u as (select left(code, 2) as k, count(*)::int as units, count(registered_voters)::int as with_voters,
                         coalesce(sum(registered_voters), 0)::bigint as voters from public.polling_units group by 1),
            w as (select left(code, 2) as k, count(*)::int as wards from public.wards group by 1),
            l as (select state_code as k, count(*)::int as lgas, count(sh.code)::int as lga_outlines,
                         count(*) filter (where lgas.senatorial_code is null)::int as no_district
                    from public.lgas left join public.area_shapes sh on sh.code = lgas.code group by 1)
       select s.code, s.name, s.zone, s.irev_state_no, s.lga_count, coalesce(l.lgas, 0) as lgas, coalesce(w.wards, 0) as wards, coalesce(u.units, 0) as units,
              coalesce(u.with_voters, 0) as with_voters, coalesce(u.voters, 0) as voters, coalesce(l.lga_outlines, 0) as lga_outlines,
              coalesce(l.no_district, 0) as no_district,
              exists (select 1 from public.area_shapes sh where sh.code = s.code) as outline,
              (select count(*) from public.constituencies c where c.state_code = s.code and c.kind = 'federal')::int as federal,
              (select count(*) from public.constituencies c where c.state_code = s.code and c.kind = 'state')::int as assembly
         from public.states s left join l on l.k = s.code left join w on w.k = s.code left join u on u.k = s.code order by s.name`);
    return rows.map((r) => {
      const issues: string[] = [];
      if (r.lgas) {
        if (r.lga_count && r.lgas < r.lga_count) issues.push(`Only ${r.lgas} of ${r.lga_count} LGAs loaded (load cut short)`);
        else if (!r.units) issues.push('No polling units');
        // The FCT has no State House of Assembly (its area councils are elected instead)
        if (!r.federal || (!r.assembly && r.code !== '37')) issues.push('Constituencies missing');
        if (!r.outline) issues.push('No state outline');
        if (r.lga_outlines < r.lgas) issues.push(`${r.lgas - r.lga_outlines} LGA(s) without an outline`);
        if (r.no_district) issues.push(`${r.no_district} LGA(s) without a senatorial district`);
      }
      return { ...r, status: !r.lgas ? 'not_loaded' : issues.length ? 'attention' : 'ready', issues };
    });
  }

  @Post('jobs/states') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Load states fully, one after another: places from IReV, constituencies, then outlines and districts. No states: every state not ready yet' })
  async loadStates(@CurrentStaff() s: PlatformUser, @Body() d: StatesJobDto) {
    const rows = await this.stateRows();
    const mode = d.mode ?? 'all';
    const local = mode === 'local', skip = mode === 'missing';
    // Local needs places already saved; without states it redoes every such state (quick: no downloads)
    const targets = d.states?.length ? rows.filter((r) => d.states!.includes(r.code))
      : rows.filter((r) => (local ? r.lgas > 0 : r.status !== 'ready'));
    if (!targets.length) throw new BadRequestException(d.states?.length ? 'Unknown state' : local ? 'No state has places yet: load them from IReV first' : 'Every state is ready already');
    const id = await this.jobs.start('states', { states: targets.map((t) => t.code), mode }, s.sid, async (log, progress) => {
      const q = (sql: string, p?: unknown[]) => this.db.system(sql, p);
      const dir = outlineDir();
      const files = OUTLINE_FILES.filter((f) => existsSync(join(dir, f.file)));
      const parsed = new Map<string, any>(); // each file read once for the whole job
      const p = { state: null as string | null, step: '', statesDone: 0, statesTotal: targets.length, failed: [] as string[], ready: 0 };
      for (const t of targets) {
        p.state = t.name;
        try {
          const skipped: string[] = [];
          // Places: skipped when the state already has polling units. New places mean constituencies and outlines run too.
          if (local && !t.lgas) throw new Error('no places saved yet: load it with IReV first');
          // A state only partly loaded (fewer LGAs than it has) counts as not loaded
          const partial = !!t.lga_count && t.lgas < t.lga_count;
          const placesNew = !local && !(skip && t.units && !partial);
          if (placesNew) {
            p.step = 'places from IReV'; progress(p);
            const g = await importGeography(q, { states: [t.code] }, (m) => log(`${t.name}: ${m}`), (gp) => progress({ ...p, units: gp.units }));
            if (!g.lgas) throw new Error('IReV gave no LGAs (check the state\'s IReV number)');
          } else skipped.push('places');
          if (!local && (placesNew || !(t.federal && (t.assembly || t.code === '37')))) {
            p.step = 'constituencies'; progress(p);
            await importConstituencies(q, [t.code], () => undefined);
          } else skipped.push('constituencies');
          const before = (await this.stateRows()).find((r) => r.code === t.code)!;
          const outlinesDone = before.outline && before.lga_outlines >= before.lgas && !before.no_district;
          let unmatched: string[] = [];
          if (skip && !placesNew && outlinesDone) skipped.push('outlines');
          else { p.step = 'outlines'; progress(p); }
          for (const f of skipped.includes('outlines') ? [] : files) {
            if (f.level === 'state' && t.outline) continue; // a state's own outline rarely changes
            if (!parsed.has(f.file)) parsed.set(f.file, JSON.parse(readFileSync(join(dir, f.file), 'utf8')));
            const r = await importBoundaries(q, parsed.get(f.file), { level: f.level, source: f.file, onlyState: t.code }, () => undefined);
            if (f.level === 'lga') unmatched = r.unmatched;
          }
          const now = (await this.stateRows()).find((r) => r.code === t.code)!;
          if (now.status === 'ready') p.ready++;
          // The file's names that matched nothing help only when one of our LGAs still has no outline
          const hint = now.lga_outlines < now.lgas && unmatched.length
            ? ` · names in the outline file not matched: ${unmatched.slice(0, 8).map((u) => u.split(' / ').pop()).join(', ')} (add them under Name matches)` : '';
          log(`${t.name}: ${now.lgas} LGAs, ${now.wards} wards, ${now.units} units · ${now.federal} Reps, ${now.assembly} Assembly · outlines ${now.lga_outlines}/${now.lgas}`
            + (now.issues.length ? ` · ${now.issues.join('; ')}${hint}` : ' · ready')
            + (skipped.length ? (local ? ` · from saved data, no IReV` : ` · skipped (already loaded): ${skipped.join(', ')}`) : ''));
        } catch (e) {
          p.failed.push(t.name);
          log(`${t.name}: stopped: ${(e as Error).message}. Load it again later (nothing is duplicated).`);
        }
        p.statesDone++; progress(p);
      }
      return { ...p, state: null, step: '' };
    });
    await audit((sql, p) => this.db.system(sql, p), s, 'places.load_states', 'job', id, { states: targets.map((t) => t.code) });
    return { id, states: targets.map((t) => t.name) };
  }

  @Patch('places/:code') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Correct a place\'s name; for a state also its zone and IReV number' })
  async update(@CurrentStaff() s: PlatformUser, @Param('code') code: string, @Body() d: PlaceUpdateDto) {
    const table = /^\d{2}$/.test(code) ? 'states' : /^\d{2}-\d{2}$/.test(code) ? 'lgas' : /^\d{2}-\d{2}-\d{2}$/.test(code) ? 'wards'
      : /^\d{2}-\d{2}-\d{2}-\d{3}$/.test(code) ? 'polling_units' : null;
    if (!table) throw new BadRequestException('Unknown area');
    if (table !== 'states' && (d.zone !== undefined || d.irevStateNo !== undefined)) throw new BadRequestException('Only states have a zone and an IReV number');
    const [r] = await this.db.system(
      `update public.${table} set name = coalesce($2, name)${table === 'states' ? ', zone = coalesce($3, zone), irev_state_no = coalesce($4, irev_state_no)' : ''}
        where code = $1 returning code`,
      table === 'states' ? [code, d.name?.trim() ?? null, d.zone ?? null, d.irevStateNo ?? null] : [code, d.name?.trim() ?? null]);
    if (!r) throw new NotFoundException('Place not found');
    await audit((sql, p) => this.db.system(sql, p), s, 'place.update', 'place', code, d as any);
    return { ok: true };
  }

  @Post('places/registered-voters') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Registered voters per polling unit from a CSV (pu_code, registered_voters)' })
  async voters(@CurrentStaff() s: PlatformUser, @Body() d: VotersDto) {
    const rows = parseCsv(d.csv.replace(/^﻿/, ''));
    if (!rows.length) throw new BadRequestException('The file is empty');
    const keys = Object.keys(rows[0]).map((k) => k.trim().toLowerCase());
    const codeKey = Object.keys(rows[0]).find((k) => ['pu_code', 'code', 'pu', 'polling_unit_code', 'delim'].includes(k.trim().toLowerCase()));
    const votersKey = Object.keys(rows[0]).find((k) => ['registered_voters', 'registered', 'voters', 'rv'].includes(k.trim().toLowerCase()));
    if (!codeKey || !votersKey) throw new BadRequestException(`Need a pu_code column and a registered_voters column (found: ${keys.join(', ')})`);
    const codes: string[] = [], counts: number[] = [], bad: string[] = [];
    rows.forEach((r, i) => {
      const code = normalisePuCode(r[codeKey] ?? '');
      const n = Number(String(r[votersKey] ?? '').replace(/[,\s]/g, ''));
      if (!code || !Number.isInteger(n) || n < 0 || n > 100_000) { bad.push(`line ${i + 2}: ${r[codeKey]} / ${r[votersKey]}`); return; }
      codes.push(code); counts.push(n);
    });
    const updated = await this.db.system(
      `update public.polling_units p set registered_voters = x.n from unnest($1::text[], $2::int[]) as x(code, n) where p.code = x.code returning p.code`, [codes, counts]);
    const found = new Set(updated.map((u) => u.code));
    const unknown = codes.filter((c) => !found.has(c));
    await audit((sql, p) => this.db.system(sql, p), s, 'places.voters', 'places', null, { updated: found.size, unknown: unknown.length, bad: bad.length });
    return { updated: found.size, unknown: unknown.slice(0, 20), unknownCount: unknown.length, bad: bad.slice(0, 20), badCount: bad.length };
  }

  @Post('jobs/geography') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Load LGAs, wards and polling units of some states from IReV, in the background' })
  async geography(@CurrentStaff() s: PlatformUser, @Body() d: GeographyJobDto) {
    if (!d.states.length) throw new BadRequestException('Pick at least one state');
    const id = await this.jobs.start('geography', d, s.sid, (log, progress) =>
      importGeography((sql, p) => this.db.system(sql, p), { states: d.states, noUnits: d.noUnits, irevElectionId: d.irevElectionId }, log, progress));
    await audit((sql, p) => this.db.system(sql, p), s, 'places.import', 'job', id, d as any);
    return { id };
  }

  @Post('jobs/outlines') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Reload map outlines from the files kept with the API (all states, or one), in the background' })
  async outlines(@CurrentStaff() s: PlatformUser, @Body() d: OutlinesJobDto) {
    const dir = outlineDir();
    const files = OUTLINE_FILES.filter((f) => existsSync(join(dir, f.file)) && (!d.state || f.level !== 'state'));
    if (!files.length) throw new BadRequestException(`No outline files found in ${dir}`);
    const id = await this.jobs.start('outlines', { state: d.state ?? null, states: d.state ? [d.state] : [] }, s.sid, async (log, progress) => {
      const done: Record<string, number> = {};
      let unmatched = 0;
      for (const f of files) {
        progress({ step: f.label, done });
        const fc = JSON.parse(readFileSync(join(dir, f.file), 'utf8'));
        const r = await importBoundaries((sql, p) => this.db.system(sql, p), fc, { level: f.level, source: f.file, onlyState: d.state },
          (m, extra) => log(`${f.label}: ${m}${extra === undefined ? '' : ': ' + (Array.isArray(extra) ? extra.slice(0, 15).join('; ') : JSON.stringify(extra))}`));
        done[f.level] = r.saved;
        if (f.level === 'senatorial') done['linked'] = r.linked ?? 0;
        if (f.level !== 'state' && f.level !== 'senatorial') unmatched += r.unmatched.length;
      }
      return { done, unmatched };
    });
    await audit((sql, p) => this.db.system(sql, p), s, 'places.outlines', 'job', id, { state: d.state ?? 'all' });
    return { id };
  }

  @Get('places/aliases')
  @ApiOperation({ summary: 'Name matches for outline files: IReV\'s spelling → the file\'s spelling (used each time outlines are loaded)' })
  async aliases() {
    const added = await this.db.system(`select level, from_key, to_key, from_name, to_name, created_at from public.place_name_aliases order by level, from_name`);
    return { added };
  }

  @Post('places/aliases') @Platform('owner', 'staff')
  async addAlias(@CurrentStaff() s: PlatformUser, @Body() d: AliasDto) {
    const from = normName(d.fromName), to = normName(d.toName);
    if (!from || !to) throw new BadRequestException('Both names need letters or digits');
    if (from === to) throw new BadRequestException('Those names already match (spaces, case and punctuation are ignored)');
    await this.db.system(
      `insert into public.place_name_aliases (level, from_key, to_key, from_name, to_name) values ($1, $2, $3, $4, $5)
       on conflict (level, from_key) do update set to_key = excluded.to_key, from_name = excluded.from_name, to_name = excluded.to_name`,
      [d.level, from, to, d.fromName.trim(), d.toName.trim()]);
    await audit((sql, p) => this.db.system(sql, p), s, 'places.alias', 'alias', `${d.level}:${from}`, d as any);
    return { level: d.level, from_key: from, to_key: to };
  }

  @Delete('places/aliases/:level/:key') @HttpCode(204) @Platform('owner', 'staff')
  async removeAlias(@CurrentStaff() s: PlatformUser, @Param('level') level: string, @Param('key') key: string) {
    await this.db.system(`delete from public.place_name_aliases where level = $1 and from_key = $2`, [level, key]);
    await audit((sql, p) => this.db.system(sql, p), s, 'places.alias_removed', 'alias', `${level}:${key}`);
  }

  @Post('jobs/constituencies') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Load House of Reps and State Assembly constituencies from IReV (all states, or some), in the background' })
  async constituencies(@CurrentStaff() s: PlatformUser, @Body() d: ConstituencyJobDto) {
    const id = await this.jobs.start('constituencies', { states: d.states ?? [] }, s.sid, (log, progress) =>
      importConstituencies((sql, p) => this.db.system(sql, p), d.states, log, progress));
    await audit((sql, p) => this.db.system(sql, p), s, 'places.constituencies', 'job', id, d as any);
    return { id };
  }

  @Get('jobs')
  jobsList() {
    return this.db.system(
      `select j.id, j.kind, j.params, j.status, j.progress, j.log, j.error, j.created_at, j.finished_at, s.full_name as by
         from public.platform_jobs j left join public.platform_staff s on s.id = j.started_by order by j.created_at desc limit 20`);
  }

  @Delete('jobs') @Platform('owner', 'staff')
  @ApiOperation({ summary: 'Clear the import history (finished loads; a running one is kept)' })
  async clearJobs(@CurrentStaff() s: PlatformUser) {
    const gone = await this.db.system(`delete from public.platform_jobs where status <> 'running' returning id`);
    await audit((sql, p) => this.db.system(sql, p), s, 'places.history_cleared', 'job', null, { removed: gone.length });
    return { removed: gone.length };
  }

  @Get('jobs/:id')
  async job(@Param('id', ParseUUIDPipe) id: string) {
    const [j] = await this.db.system(`select id, kind, params, status, progress, log, error, created_at, finished_at from public.platform_jobs where id = $1`, [id]);
    if (!j) throw new NotFoundException('Job not found');
    return j;
  }
}
