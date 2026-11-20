import {
  Injectable,
  NotFoundException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, createHash } from 'node:crypto';
import { EnvironmentVariables } from '../config/env.validation';
import { TenantDb } from '../tenancy/tenant-db';

export const tokenHash = (token: string) =>
  createHash('sha256').update(token).digest();

@Injectable()
export class SessionsService {
  constructor(
    private readonly db: TenantDb,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  create(tenantId: string) {
    const token = 'ffs_' + randomBytes(32).toString('hex');
    return this.db.run(tenantId, async (em) => {
      await em.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('ff.sessions:' || $1,0))`,
        [tenantId],
      );
      await em.query(
        `DELETE FROM browser_sessions WHERE "tenantId"=$1 AND ("expiresAt"<=clock_timestamp() OR id IN (
        SELECT id FROM browser_sessions WHERE "tenantId"=$1 AND "expiresAt">clock_timestamp()
        ORDER BY "createdAt" DESC,id DESC OFFSET $2))`,
        [
          tenantId,
          this.config.get('SESSION_MAX_PER_TENANT', { infer: true }) - 1,
        ],
      );
      const [session] = await em.query<Array<{ expiresAt: Date }>>(
        `INSERT INTO browser_sessions ("tenantId","tokenHash","expiresAt") VALUES ($1,$2,clock_timestamp()+$3 * interval '1 millisecond') RETURNING "expiresAt"`,
        [
          tenantId,
          tokenHash(token),
          this.config.get('SESSION_TTL_MS', { infer: true }),
        ],
      );
      return { token, expiresAt: session.expiresAt };
    });
  }

  revoke(tenantId: string, id?: string) {
    if (!id) throw new UnauthorizedException('Потрібна браузерна сесія');
    return this.db.run(tenantId, async (em) => {
      await em.query(
        'DELETE FROM browser_sessions WHERE id=$1 AND "tenantId"=$2',
        [id, tenantId],
      );
    });
  }

  ticket(tenantId: string, executionId: string, sessionId?: string) {
    const ticket = 'fft_' + randomBytes(32).toString('hex');
    return this.db.run(tenantId, async (em) => {
      await em.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('ff.tickets:' || $1,0))`,
        [tenantId],
      );
      if (sessionId) {
        const rows = await em.query<unknown[]>(
          `SELECT id FROM browser_sessions WHERE id=$1 AND "tenantId"=$2 AND "expiresAt">clock_timestamp()`,
          [sessionId, tenantId],
        );
        if (!rows.length) throw new UnauthorizedException();
      }
      const owned = await em.query<unknown[]>(
        'SELECT id FROM executions WHERE id=$1 AND "tenantId"=$2',
        [executionId, tenantId],
      );
      if (!owned.length) throw new NotFoundException('Виконання не знайдено');
      await em.query(
        'DELETE FROM realtime_tickets WHERE "tenantId"=$1 AND "expiresAt"<=clock_timestamp()',
        [tenantId],
      );
      const [{ full }] = await em.query<Array<{ full: boolean }>>(
        'SELECT EXISTS(SELECT 1 FROM realtime_tickets WHERE "tenantId"=$1 OFFSET 99) AS full',
        [tenantId],
      );
      if (full) throw new HttpException('Ліміт одночасних тикетів', 429);
      const [result] = await em.query<Array<{ expiresAt: Date }>>(
        `INSERT INTO realtime_tickets ("tenantId","executionId","sessionId","tokenHash","expiresAt")
        VALUES ($1,$2,$3,$4,clock_timestamp()+$5 * interval '1 millisecond') RETURNING "expiresAt"`,
        [
          tenantId,
          executionId,
          sessionId ?? null,
          tokenHash(ticket),
          this.config.get('REALTIME_TICKET_TTL_MS', { infer: true }),
        ],
      );
      return { ticket, expiresAt: result.expiresAt };
    });
  }
}
