import { MigrationInterface, QueryRunner } from 'typeorm';
import { rateLimitHitSql } from './1795300000000-TenantLimits';

/**
 * Лічильник ліміту частоти бере момент після блокування рядка відра (docs/architecture.md, «Ліміти тенанта»):
 * запит, що чекав на рядок довше за залишок вікна, рахується вже в новому вікні. CREATE OR REPLACE
 * зберігає власника (системна роль) і права EXECUTE функції.
 */
export class RateLimitLockTime1795910000000 implements MigrationInterface {
  name = 'RateLimitLockTime1795910000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(rateLimitHitSql(2));
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      rateLimitHitSql(1).replace(
        'CREATE FUNCTION',
        'CREATE OR REPLACE FUNCTION',
      ),
    );
  }
}
