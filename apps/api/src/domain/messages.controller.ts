import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn, selectFn } from '../common/fn';
import { ProvidersService } from '../common/providers.service';
import { CALL_MODES, type CallMode, requireCallMode } from '../common/tenant-settings';

class MessageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) body?: string;
  @ApiPropertyOptional({ enum: ['text', 'voice', 'photo', 'video'] }) @IsOptional() @IsIn(['text', 'voice', 'photo', 'video']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) mediaPath?: string;
  @ApiProperty() @IsUUID() clientId: string;
}
class DirectDto { @ApiProperty() @IsUUID() otherId: string; }
class ChannelCallDto {
  @ApiProperty() @IsUUID() personId: string;
  @ApiPropertyOptional({ enum: CALL_MODES, default: 'phone' }) @IsOptional() @IsIn(CALL_MODES) mode?: CallMode;
}

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('channels')
export class MessagesController {
  constructor(private readonly db: Db, private readonly providers: ProvidersService) {}

  /** Channels the caller belongs to (the database decides: case, area and direct channels). */
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => q(
      `select c.*, (select max(created_at) from public.messages m where m.channel_id = c.id) as last_at
         from public.channels c where c.tenant_id = $1 order by last_at desc nulls last, c.created_at desc limit 100`, [u.tid]));
  }

  @Get('area')
  area(@CurrentUser() u: AuthUser) {
    return this.db.asUser(u, (q) => selectFn(q, 'my_area_channels'));
  }

  @Post('direct')
  async direct(@CurrentUser() u: AuthUser, @Body() d: DirectDto) {
    return { channelId: await this.db.asUser(u, (q) => callFn(q, 'open_direct_channel', { p_other: d.otherId })) };
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.asUser(u, async (q) => {
      const [channel] = await q(`select * from public.channels where id = $1 and tenant_id = $2`, [id, u.tid]);
      if (!channel) throw new NotFoundException('Conversation not found');
      const messages = await selectFn(q, 'channel_messages', { p_channel: id, p_limit: 200 });
      await q(`insert into public.channel_reads (channel_id, volunteer_id, last_read_at) values ($1, $2, now())
               on conflict (channel_id, volunteer_id) do update set last_read_at = now()`, [id, u.mid]);
      return { channel, messages: messages.reverse() };
    });
  }

  /**
   * People in this conversation the caller can phone: the other person in a direct chat,
   * or everyone who has written in a case or area chat. Only for people who can open the chat.
   */
  @Get(':id/people')
  async people(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    // the access check runs as the user (row-level security decides); the list itself needs other people's rows
    const [ok] = await this.db.asUser(u, (q) => q(`select 1 from public.channels where id = $1 and tenant_id = $2`, [id, u.tid]));
    if (!ok) throw new NotFoundException('Conversation not found');
    return this.db.system(
        `select v.id, v.full_name, v.role from public.channels c
           join public.volunteers v on v.tenant_id = c.tenant_id and v.status <> 'removed' and v.id <> $2
          where c.id = $1 and (
            (c.kind = 'direct' and v.id in (c.member_a, c.member_b))
            or (c.kind <> 'direct' and exists (select 1 from public.messages m where m.channel_id = c.id and m.sender_id = v.id)))
          order by v.full_name`, [id, u.mid]);
  }

  /**
   * Calls someone in this conversation, the way the organisation allows (see common/tenant-settings):
   *  - phone:  returns their number for the phone's dialler
   *  - bridged: Rumfa rings the caller's phone, then connects the other person; no number is returned
   *  - webrtc: registers the number so the internet call from the app is let through; returns it for the call client
   */
  @Post(':id/call') @HttpCode(200)
  async call(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ChannelCallDto) {
    const mode = d.mode ?? 'phone';
    await requireCallMode(this.db, u.tid, mode);
    const people = await this.people(u, id) as { id: string }[];
    if (!people.some((p) => p.id === d.personId)) throw new NotFoundException('This person is not in the conversation');
    const [other] = await this.db.system(`select id, phone from public.volunteers where id = $1 and tenant_id = $2`, [d.personId, u.tid]);
    if (!other?.phone) throw new NotFoundException('No phone number for this person');
    const route = ({ phone: 'gsm_direct', bridged: 'bridged', webrtc: 'webrtc_pstn' } as const)[mode];
    const [row] = await this.db.system(
      `insert into public.calls (tenant_id, caller_id, callee_id, to_phone, route, reason)
       values ($1, $2, $3, $4, $5, 'from chat') returning id`, [u.tid, u.mid, other.id, other.phone, route]);
    if (mode === 'bridged') {
      const [me] = await this.db.system(`select phone from public.volunteers where id = $1`, [u.mid]);
      try {
        const sessionId = await this.providers.atMakeCall(me.phone, row.id);
        await this.db.system(`update public.calls set provider_session_id = $2, status = 'ringing' where id = $1`, [row.id, sessionId]);
      } catch (e) {
        await this.db.system(`update public.calls set status = 'failed', ended_at = now() where id = $1`, [row.id]);
        throw e;
      }
      return { callId: row.id, mode };
    }
    return { callId: row.id, mode, phone: other.phone };
  }

  @Post(':id/messages')
  async send(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: MessageDto) {
    if (!d.body && !d.mediaPath) throw new BadRequestException('Write a message or attach a file');
    if (d.mediaPath && !d.mediaPath.startsWith(`${u.tid}/`)) throw new BadRequestException('Unknown file');
    const [row] = await this.db.asUser(u, (q) => q(
      `insert into public.messages (tenant_id, channel_id, sender_id, kind, body, media_path, client_id)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (client_id) do update set client_id = excluded.client_id returning *`,
      [u.tid, id, u.mid, d.kind ?? (d.mediaPath ? 'photo' : 'text'), d.body ?? null, d.mediaPath ?? null, d.clientId]));
    return row;
  }
}
