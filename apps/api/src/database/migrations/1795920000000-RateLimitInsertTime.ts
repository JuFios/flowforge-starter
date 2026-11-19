import { MigrationInterface, QueryRunner } from 'typeorm';
import { rateLimitHitSql } from './1795300000000-TenantLimits';

export class RateLimitInsertTime1795920000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(rateLimitHitSql(3));
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(rateLimitHitSql(2));
  }
}
