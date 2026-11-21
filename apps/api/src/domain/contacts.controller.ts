import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';
import { normaliseNgPhone } from '../shared';
import { callFn } from '../common/fn';
import { ROOM } from './roles';
import { withCasePlaces } from './case-places';

class ContactDto {
  @ApiProperty() @IsString() @MaxLength(120) agency: string;
  @ApiProperty() @IsString() @MaxLength(120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) person?: string;
  @ApiProperty() @IsString() @MaxLength(20) phone: string;
  @ApiProperty({ enum: ['national', 'state', 'lga', 'ward'] }) @IsIn(['national', 'state', 'lga', 'ward']) level: string;
  @ApiProperty() @IsString() @MaxLength(20) areaCode: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
class ApproveDto { @ApiProperty() @IsBoolean() approve: boolean; }
class CallResultDto { @ApiProperty() @IsBoolean() ok: boolean; }

@ApiTags('Authority contacts')
@ApiBearerAuth()
@Controller('contacts')
@Roles('coordinator', ...ROOM)
export class ContactsController {
  constructor(private readonly db: Db) {}

  @Get()
  async list(@CurrentUser() u: AuthUser, @Query('area') area?: string, @Query('status') status?: string) {
    // With each one's place by name
    return (await withCasePlaces(this.db, await this.db.asUser(u, (q) => q(
      `select * from public.authority_contacts
        where (tenant_id = $1 or tenant_id is null) -- with the official ones Rumfa keeps for every client
          and ($2::text is null or area_code like $2 || '%') and ($3::text is null or status = any(string_to_array($3, ',')))
        order by area_code, agency limit 2000`, [u.tid, area || null, status || null])))).map(({ what, ...k }) => k);
  }

  @Post()
  async add(@CurrentUser() u: AuthUser, @Body() d: ContactDto) {
    const phone = normaliseNgPhone(d.phone) ?? (/^\+?\d{7,15}$/.test(d.phone) ? d.phone : null);
    if (!phone) throw new BadRequestException('Check the phone number');
    return { id: await this.db.asUser(u, (q) => callFn(q, 'add_authority_contact', {
      p_agency: d.agency, p_title: d.title, p_person: d.person ?? null, p_phone: phone, p_level: d.level, p_area: d.areaCode, p_notes: d.notes ?? null,
    })) };
  }

  @Post(':id/approve') @HttpCode(204)
  async approve(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ApproveDto) {
    await this.db.asUser(u, (q) => callFn(q, 'approve_contact', { p_contact: id, p_approve: d.approve }));
  }

  @Post(':id/call-result') @HttpCode(204)
  async callResult(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: CallResultDto) {
    await this.db.asUser(u, (q) => callFn(q, 'mark_contact_call', { p_contact: id, p_ok: d.ok }));
  }
}
