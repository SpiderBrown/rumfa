import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Db } from '../database/db.service';
import { CurrentStaff, Platform } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { audit } from './audit';

class RetryDto { @ApiPropertyOptional({ description: 'Only this template' }) @IsOptional() @IsString() @MaxLength(60) template?: string; }

/**
 * Rumfa Console: everything the worker does in the background, across all clients. Whether the worker is alive (its
 * tasks' heartbeats), IReV jobs, notifications waiting or failed, voice messages and campaigns, top-ups, sheet
 * reading (OCR) and place imports.
 */
@ApiTags('Rumfa Console: background jobs')
@ApiBearerAuth()
@Controller('platform/background')
@Platform()
export class PlatformJobsController {
  constructor(private readonly db: Db) {}
  private q = (sql: string, p?: unknown[]) => this.db.system(sql, p);

  @Get('overview')
  @ApiOperation({ summary: 'Worker heartbeats and every queue, in one go' })
  async overview() {
    const [worker, irev, outboxCounts, outboxOldest, outboxFailures, voiceMessages, campaigns, topups, ocr, places] = await Promise.all([
      this.q(`select task, every_s, last_run_at, last_ok_at, last_error, last_error_at, runs, worker from public.worker_heartbeats order by task`),
      this.q(`select j.id, j.job_type, j.area_level, j.area_code, j.status, j.keep, j.auto_recheck, j.interval_min, j.watcher, j.counts, j.error,
                     j.created_at, j.started_at, j.finished_at, j.next_run_at, e.name as election, t.name as client
                from public.irev_fetch_jobs j join public.elections e on e.id = j.election_id left join public.tenants t on t.id = j.tenant_id
               order by (j.status in ('queued','running','paused')) desc, j.created_at desc limit 40`),
      this.q(`select channel, status, count(*)::int as n from public.outbox where created_at > now() - interval '7 days' group by 1, 2`),
      this.q(`select min(created_at) as oldest, count(*)::int as n from public.outbox where status = 'queued'`),
      this.q(`select o.id, o.channel, o.template, o.attempts, o.last_error, o.created_at, t.name as client
                from public.outbox o left join public.tenants t on t.id = o.tenant_id where o.status = 'failed' order by o.created_at desc limit 15`),
      this.q(`select a.id, a.title, a.status, a.created_at, a.ends_at, t.name as client,
                     (select json_object_agg(status, n) from (select status, count(*)::int n from public.voice_announcement_calls c where c.announcement_id = a.id group by status) s) as counts
                from public.voice_announcements a join public.tenants t on t.id = a.tenant_id
               where a.status = 'sending' or a.created_at > now() - interval '2 days' order by a.created_at desc limit 10`),
      this.q(`select c.id, c.name, c.status, c.calls_per_minute, t.name as client,
                     (select json_object_agg(status, n) from (select status, count(*)::int n from public.voice_call_attempts a where a.campaign_id = c.id group by status) s) as counts
                from public.voice_campaigns c join public.tenants t on t.id = c.tenant_id where c.status in ('approved','running','paused') order by c.created_at desc limit 10`),
      this.q(`select b.id, b.status, b.person_count, b.total_ngn, b.created_at, t.name as client,
                     (select json_object_agg(status, n) from (select status, count(*)::int n from public.topups x where x.batch_id = b.id group by status) s) as counts
                from public.topup_batches b join public.tenants t on t.id = b.tenant_id where b.status in ('pending_approval','approved','sending') order by b.created_at desc limit 10`),
      this.q(`select count(*)::int as waiting, min(s.submitted_at) as oldest from public.result_submissions s
               where s.sheet_photo_path is not null and not exists (select 1 from public.ocr_extractions o where o.submission_id = s.id)`),
      this.q(`select j.id, j.kind, j.params, j.status, j.progress, j.error, j.created_at, j.finished_at, ps.full_name as by
                from public.platform_jobs j left join public.platform_staff ps on ps.id = j.started_by order by j.created_at desc limit 10`),
    ]);
    return { now: new Date().toISOString(), worker, irev, outbox: { counts: outboxCounts, queued: outboxOldest[0], failures: outboxFailures },
      voiceMessages, campaigns, topups, ocr: ocr[0], places };
  }

  /** Puts failed notifications back in the queue (e.g. after fixing the SMS or push settings) */
  @Post('outbox/retry') @HttpCode(200) @Platform('owner', 'staff')
  async retry(@CurrentStaff() s: PlatformUser, @Body() d: RetryDto) {
    const r = await this.db.system(
      `update public.outbox set status = 'queued', attempts = 0, last_error = null
        where status = 'failed' and created_at > now() - interval '2 days' and ($1::text is null or template = $1) returning id`, [d.template ?? null]);
    await audit(this.q, s, 'outbox.retry', 'outbox', null, { template: d.template ?? null, count: r.length });
    return { requeued: r.length };
  }
}
