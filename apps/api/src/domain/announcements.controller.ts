import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { ProvidersService } from '../common/providers.service';
import { AppCallsService, GROUP_CALLERS } from './app-calls.service';

/** How many people one voice message can go to */
export const ANNOUNCE_MAX = 3000;

class AudienceDto {
  @ApiProperty() @IsString() @MaxLength(20) area: string;
  @ApiProperty({ enum: ['coordinator', 'agent', 'volunteer'], isArray: true }) @IsArray() @ArrayMinSize(1) @IsIn(['coordinator', 'agent', 'volunteer'], { each: true }) roles: string[];
}
class AnnounceDto extends AudienceDto {
  @ApiProperty({ description: 'From POST /media/upload-url (kind announcement): a WAV or MP3' }) @IsString() @MaxLength(300) audioPath: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(120) durationS?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) title?: string;
  @ApiPropertyOptional({ description: 'Hours to keep trying people out of network' }) @IsOptional() @IsInt() @Min(1) @Max(12) hours?: number;
}

/**
 * Voice messages (My field team): record a short message once; everyone of the chosen roles in an area gets a phone
 * call that plays it and hangs up. People out of network are tried again later. The worker places the calls.
 */
@ApiTags('Voice messages')
@ApiBearerAuth()
@Controller('announcements/voice')
@Roles(...GROUP_CALLERS)
export class AnnouncementsController {
  constructor(private readonly db: Db, private readonly appCalls: AppCallsService, private readonly providers: ProvidersService) {}

  @Post('preview') @HttpCode(200)
  @ApiOperation({ summary: 'Who a voice message to these roles in this area would call' })
  async preview(@CurrentUser() u: AuthUser, @Body() d: AudienceDto) {
    const a = await this.appCalls.groupAudience(u, d.area, d.roles, ANNOUNCE_MAX);
    return { count: a.people.length, more: a.more, names: a.people.slice(0, 5).map((p) => p.full_name), canCall: this.providers.atVoiceReady() };
  }

  @Post() @HttpCode(200)
  @ApiOperation({ summary: 'Send a recorded voice message as phone calls' })
  async send(@CurrentUser() u: AuthUser, @Body() d: AnnounceDto) {
    if (!d.audioPath.startsWith(`${u.tid}/announcement/`)) throw new BadRequestException('Record the message first');
    const a = await this.appCalls.groupAudience(u, d.area, d.roles, ANNOUNCE_MAX);
    if (!a.people.length) throw new BadRequestException('Nobody to call there');
    if (a.more) throw new BadRequestException(`Up to ${ANNOUNCE_MAX} people in one message. Choose a smaller area or fewer roles.`);
    return this.db.systemTx(async (q) => {
      const [m] = await q(
        `insert into public.voice_announcements (tenant_id, created_by, title, area_code, roles, audio_path, duration_s, ends_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8)) returning id`,
        [u.tid, u.mid, d.title?.trim() || 'Voice message', d.area, a.roles, d.audioPath, d.durationS ?? null, d.hours ?? 3]);
      await q(
        `insert into public.voice_announcement_calls (announcement_id, tenant_id, volunteer_id, phone)
         select $1, $2, v.id, v.phone from public.volunteers v where v.id = any($3) and v.phone is not null`,
        [m.id, u.tid, a.people.map((p) => p.id)]);
      return { id: m.id, people: a.people.length, canCall: this.providers.atVoiceReady() };
    });
  }

  /** Recent voice messages (mine; supervisors and admins see all) with how many have heard it */
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.db.system(
      `select a.id, a.title, a.area_code, a.roles, a.duration_s, a.status, a.created_at, a.ends_at, v.full_name as sender,
              (select json_object_agg(status, n) from (select status, count(*)::int n from public.voice_announcement_calls c where c.announcement_id = a.id group by status) s) as counts
         from public.voice_announcements a join public.volunteers v on v.id = a.created_by
        where a.tenant_id = $1 and (a.created_by = $2 or $3) order by a.created_at desc limit 20`,
      [u.tid, u.mid, ['supervisor', 'admin'].includes(u.role)]);
  }

  @Get(':id')
  async one(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [a] = await this.db.system(`select * from public.voice_announcements where id = $1 and tenant_id = $2 and (created_by = $3 or $4)`,
      [id, u.tid, u.mid, ['supervisor', 'admin'].includes(u.role)]);
    if (!a) throw new NotFoundException('Voice message not found');
    const people = await this.db.system(
      `select c.volunteer_id as id, v.full_name, v.role, v.area_code, c.status, c.attempts, c.next_try_at, c.heard_s
         from public.voice_announcement_calls c join public.volunteers v on v.id = c.volunteer_id where c.announcement_id = $1 order by v.full_name`, [id]);
    return { ...a, people };
  }

  @Post(':id/cancel') @HttpCode(200)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const [a] = await this.db.system(
      `update public.voice_announcements set status = 'cancelled' where id = $1 and tenant_id = $2 and (created_by = $3 or $4) and status = 'sending' returning id`,
      [id, u.tid, u.mid, ['supervisor', 'admin'].includes(u.role)]);
    if (a) await this.db.system(`update public.voice_announcement_calls set status = 'cancelled', updated_at = now() where announcement_id = $1 and status in ('waiting','no_answer','busy','failed')`, [id]);
    return { status: 'cancelled' };
  }
}
