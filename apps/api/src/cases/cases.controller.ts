import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Db } from '../database/db.service';

@ApiTags('Cases')
@ApiBearerAuth()
@Controller('cases')
export class CasesController {
  constructor(private readonly db: Db) {}

  /** Cases the caller may see: room staff in their area, coordinators in their area, reporters their own. */
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('status') status?: string) {
    return this.db.asUser(user, (q) => q(
      `select id, title, category, severity, status, pu_code, area_code, report_count, assigned_to, created_at, ack_due_at, due_at
         from public.cases
        where tenant_id = $1 and ($2::text is null or status = $2)
        order by created_at desc limit 200`,
      [user.tid, status ?? null]));
  }
}
