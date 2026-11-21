import { Body, Controller, ForbiddenException, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser, Roles, Addon } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn } from '../common/fn';
import { ProvidersService } from '../common/providers.service';
import { ROOM } from './roles';

class AnswerDto {
  @ApiProperty() @IsBoolean() accept: boolean;
  @ApiPropertyOptional({ enum: ['live', 'clip'] }) @IsOptional() @IsIn(['live', 'clip']) mode?: string;
}
class EndDto { @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) mediaPath?: string; }

/** Supervisor asks to see a unit; the agent accepts and streams (or sends a short clip on a weak connection). */
@ApiTags('Live view')
@ApiBearerAuth()
@Controller('live-view/:id')
@Addon('liveVideo')
export class LiveViewController {
  constructor(private readonly db: Db, private readonly providers: ProvidersService) {}

  private async request(u: AuthUser, id: string) {
    const [r] = await this.db.asUser(u, (q) => q(`select * from public.live_view_requests where id = $1 and tenant_id = $2`, [id, u.tid]));
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  @Post('answer') @HttpCode(204)
  async answer(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: AnswerDto) {
    await this.db.asUser(u, (q) => callFn(q, 'answer_live_view', { p_id: id, p_accept: d.accept, p_mode: d.mode ?? 'live' }));
  }

  @Post('publish-token') @HttpCode(200)
  async publish(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.request(u, id);
    if (r.agent_id !== u.mid || !['accepted', 'live'].includes(r.status)) throw new ForbiddenException('Not allowed');
    await this.db.system(`update public.live_view_requests set status = 'live', mode = 'live', started_at = now() where id = $1`, [id]);
    return { url: this.providers.livekitUrl(), token: this.providers.livekitToken(u.mid, 'agent', r.room_name, true) };
  }

  @Post('view-token') @HttpCode(200) @Roles(...ROOM)
  async view(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const r = await this.request(u, id);
    if (r.requested_by !== u.mid && !['supervisor', 'admin'].includes(u.role)) throw new ForbiddenException('Not allowed');
    return { url: this.providers.livekitUrl(), token: this.providers.livekitToken(u.mid, 'room', r.room_name, false) };
  }

  @Post('end') @HttpCode(204)
  async end(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: EndDto) {
    const r = await this.request(u, id);
    if (r.agent_id !== u.mid && r.requested_by !== u.mid) throw new ForbiddenException('Not allowed');
    if (d.mediaPath && !d.mediaPath.startsWith(`${u.tid}/`)) throw new ForbiddenException('Unknown file');
    await this.db.system(
      `update public.live_view_requests set status = $2, ended_at = now(), media_path = coalesce($3, media_path),
              mode = case when $3::text is not null then 'clip' else mode end where id = $1`,
      [id, d.mediaPath ? 'clip_uploaded' : 'ended', d.mediaPath ?? null]);
    if (r.case_id) {
      await this.db.system(`select public.svc_case_event($1, $2, null, $3, $4)`,
        [r.case_id, d.mediaPath ? 'clip_uploaded' : 'live_view_ended', JSON.stringify({ request_id: id, media_path: d.mediaPath ?? null }), u.mid]);
    }
  }
}
