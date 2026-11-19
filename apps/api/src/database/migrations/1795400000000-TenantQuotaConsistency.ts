import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  claimJobSql,
  tenantUsageOnTenantSql,
} from './1795200000000-TenantUsage';
import { purgeRateLimitsSql } from './1795300000000-TenantLimits';

export class TenantQuotaConsistency1795400000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await this.install(runner, true);
    // Тригер повторно звіряє з джерелом істини також рядки, створені старою версією.
    await runner.query(
      'UPDATE public.limit_defaults SET "maxRunning" = "maxRunning" WHERE id',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await this.install(runner, false);
  }
  private async install(runner: QueryRunner, bounded: boolean): Promise<void> {
    for (const sql of [
      claimJobSql(bounded),
      tenantUsageOnTenantSql(bounded),
      purgeRateLimitsSql(bounded),
    ])
      await runner.query(
        sql.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'),
      );
    await runner.query('DROP INDEX public."IDX_tenant_usage_maturing"');
    const eligible = bounded ? ' AND running < "maxRunning"' : '';
    await runner.query(`CREATE INDEX "IDX_tenant_usage_maturing" ON public.tenant_usage ("nextRunAt")
        WHERE NOT ready AND "nextRunAt" IS NOT NULL${eligible}`);
  }
}
