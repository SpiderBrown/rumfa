import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { callFn, selectFn } from '../common/fn';

class MessageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) body?: string;
  @ApiPropertyOptional({ enum: ['text', 'voice', 'photo', 'video'] }) @IsOptional() @IsIn(['text', 'voice', 'photo', 'video']) kind?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) mediaPath?: string;
  @ApiProperty() @IsUUID() clientId: string;
}
class DirectDto { @ApiProperty() @IsUUID() otherId: string; }

@ApiTags('Messages')
@ApiBearerAuth()
@Controller('channels')
export class MessagesController {
  constructor(private readonly db: Db) {}

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
