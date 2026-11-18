// Official authority contacts (INEC offices, police commands, ...), kept once by Rumfa for every client: rows with
// no tenant. Every client's dashboard shows them next to the contacts its own people add.
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags, PartialType } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { Db } from '../database/db.service';
import { CurrentStaff, Platform } from '../auth/decorators';
import type { PlatformUser } from '../auth/auth.types';
import { normaliseNgPhone } from '../shared';
import { audit } from './audit';
import { AREA_NAME } from './platform-clients.controller';

export const AGENCIES = ['INEC', 'Police', 'Army', 'NSCDC', 'DSS', 'Party legal team', 'Traditional ruler', 'Local government', 'Other'];
const LEVELS = ['national', 'state', 'lga', 'ward'] as const;
const AREA = { national: /^NG$/, state: /^\d{2}$/, lga: /^\d{2}-\d{2}$/, ward: /^\d{2}-\d{2}-\d{2}$/ };

class ContactDto {
  @ApiProperty({ enum: AGENCIES }) @IsIn(AGENCIES) agency: string;
  @ApiProperty({ example: 'Resident Electoral Commissioner' }) @IsString() @Length(2, 120) title: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) person?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) phone?: string;
  @ApiPropertyOptional({ description: 'Empty to remove' }) @IsOptional() @Matches(/^$|^[^@\s]+@[^@\s]+\.[^@\s]+$/, { message: 'Check the email' }) @MaxLength(200) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?: string;
  @ApiProperty({ enum: LEVELS }) @IsIn(LEVELS) level: (typeof LEVELS)[number];
  @ApiProperty({ description: 'NG, a state (19), an LGA (19-05) or a ward (19-05-03)' }) @Matches(/^(NG|\d{2}(-\d{2}){0,2})$/) areaCode: string;
  @ApiPropertyOptional({ enum: ['pending', 'verified'], description: 'verified: the number is known to work' }) @IsOptional() @IsIn(['pending', 'verified']) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) notes?: string;
}
class ContactUpdateDto extends PartialType(ContactDto) {}

@ApiTags('Rumfa Console · authority contacts')
@ApiBearerAuth()
@Controller('platform/contacts')
@Platform()
export class PlatformContactsController {
  constructor(private readonly db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Official contacts (shared by every client), optionally for one state and its LGAs and wards' })
  async list(@Query('state') state?: string) {
    if (state && !/^(NG|\d{2})$/.test(state)) throw new BadRequestException('Unknown state');
    const items = await this.db.system(
      `select c.id, c.agency, c.title, c.person_name, c.phone, c.email, c.address, c.level, c.area_code, ${AREA_NAME('c.area_code')} as area_name,
              c.status, c.notes, c.source_type, c.source_url, c.last_call_ok_at, c.last_call_failed_at, c.updated_at
         from public.authority_contacts c
        where c.tenant_id is null and ($1::text is null or c.area_code = $1 or c.area_code like $1 || '-%')
        order by c.area_code, c.agency, c.title limit 3000`, [state || null]);
    return { items, agencies: AGENCIES };
  }

  @Post() @Platform('owner', 'staff')
  async add(@CurrentStaff() s: PlatformUser, @Body() d: ContactDto) {
    const v = await this.clean(d);
    const [row] = await this.db.system(
      `insert into public.authority_contacts (tenant_id, agency, title, person_name, phone, email, address, level, area_code, status, source_type, notes)
       values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'official', $10) returning id`,
      [d.agency, d.title.trim(), v.person, v.phone, v.email, v.address, d.level, d.areaCode, d.status ?? 'verified', v.notes]);
    await audit((sql, p) => this.db.system(sql, p), s, 'contact.add', 'contact', row.id, { agency: d.agency, title: d.title, area: d.areaCode });
    return row;
  }

  @Patch(':id') @Platform('owner', 'staff')
  async update(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string, @Body() d: ContactUpdateDto) {
    const [c] = await this.db.system(`select * from public.authority_contacts where id = $1 and tenant_id is null`, [id]);
    if (!c) throw new NotFoundException('Contact not found');
    const merged = { agency: c.agency, title: c.title, person: c.person_name, phone: c.phone, email: c.email, address: c.address,
      level: c.level, areaCode: c.area_code, status: c.status, notes: c.notes, ...Object.fromEntries(Object.entries(d).filter(([, x]) => x !== undefined)) };
    const v = await this.clean(merged as ContactDto);
    await this.db.system(
      `update public.authority_contacts set agency = $2, title = $3, person_name = $4, phone = $5, email = $6, address = $7, level = $8, area_code = $9,
              status = $10, notes = $11, updated_at = now() where id = $1`,
      [id, merged.agency, String(merged.title).trim(), v.person, v.phone, v.email, v.address, merged.level, merged.areaCode, merged.status, v.notes]);
    await audit((sql, p) => this.db.system(sql, p), s, 'contact.update', 'contact', id, d as any);
    return { ok: true };
  }

  @Delete(':id') @HttpCode(204) @Platform('owner', 'staff')
  async remove(@CurrentStaff() s: PlatformUser, @Param('id', ParseUUIDPipe) id: string) {
    const gone = await this.db.system(`delete from public.authority_contacts where id = $1 and tenant_id is null returning agency, title, area_code`, [id]);
    if (!gone.length) throw new NotFoundException('Contact not found');
    await audit((sql, p) => this.db.system(sql, p), s, 'contact.remove', 'contact', id, gone[0]);
  }

  /** Checks the area and phone; empty text becomes null */
  private async clean(d: ContactDto) {
    if (!AREA[d.level].test(d.areaCode)) throw new BadRequestException(`Pick ${d.level === 'national' ? 'Nigeria' : `a ${d.level === 'lga' ? 'LGA' : d.level}`} for a ${d.level} contact`);
    if (d.areaCode !== 'NG') {
      const table = { state: 'states', lga: 'lgas', ward: 'wards', national: 'states' }[d.level];
      if (!(await this.db.system(`select 1 from public.${table} where code = $1`, [d.areaCode])).length) throw new BadRequestException('Unknown place');
    }
    const blank = (x?: string | null) => (x && x.trim() ? x.trim() : null);
    let phone = blank(d.phone);
    if (phone) {
      phone = normaliseNgPhone(phone) ?? (/^\+?\d{7,15}$/.test(phone) ? phone : null);
      if (!phone) throw new BadRequestException('Check the phone number');
    }
    if (!phone && !blank(d.email) && !blank(d.address)) throw new BadRequestException('Give a phone number, an email or an address');
    return { person: blank(d.person), phone, email: blank(d.email), address: blank(d.address), notes: blank(d.notes) };
  }
}
