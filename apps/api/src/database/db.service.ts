import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import type { AuthUser } from '../auth/auth.types';

export type Query = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Two ways to reach the database:
 * - `asUser`: a signed-in person's request. One transaction that sets app.user_id / app.tenant_id and
 *   switches to the rumfa_api role, so every row-level security policy applies on top of the API's checks.
 * - `system` / `systemTx`: the API's own work (sign-in, webhooks) as the owner. Use only where no user
 *   data is returned without a check in code.
 */
@Injectable()
export class Db {
  constructor(private readonly ds: DataSource) {}

  async asUser<T>(user: Pick<AuthUser, 'sub' | 'tid'>, fn: (q: Query) => Promise<T>): Promise<T> {
    return this.run(async (qr) => {
      await qr.query(`select set_config('app.user_id', $1, true), set_config('app.tenant_id', $2, true)`, [user.sub, user.tid]);
      await qr.query('set local role rumfa_api');
      return fn((sql, params) => qr.query(sql, params));
    });
  }

  async system<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      return await this.ds.query(sql, params);
    } catch (e) {
      throw mapDbError(e);
    }
  }

  async systemTx<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    return this.run((qr) => fn((sql, params) => qr.query(sql, params)));
  }

  private async run<T>(fn: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const result = await fn(qr);
      await qr.commitTransaction();
      return result;
    } catch (e) {
      await qr.rollbackTransaction().catch(() => undefined);
      throw mapDbError(e);
    } finally {
      await qr.release();
    }
  }
}

/** Database errors → HTTP errors. Business rules in SQL raise plain exceptions with a readable message. */
export function mapDbError(e: any): unknown {
  const code: string | undefined = e?.code ?? e?.driverError?.code;
  const msg: string = e?.driverError?.message ?? e?.message ?? 'Database error';
  if (!code || e?.getStatus) return e;
  if (code === '42501') return new ForbiddenException('Not allowed');
  if (code === '23505') return new ConflictException('Already exists');
  if (code === '23503') return new BadRequestException('Refers to a record that does not exist');
  if (code === 'P0002') return new NotFoundException(msg);
  if (code === 'P0001' || code.startsWith('22') || code === '23514') return new BadRequestException(msg);
  return e;
}
