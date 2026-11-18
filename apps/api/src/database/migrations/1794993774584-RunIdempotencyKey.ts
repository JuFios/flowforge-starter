import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Ключ ідемпотентності запуску: колонка й частковий унікальний індекс (лише рядки з ключем —
 * виконання без ключа, тобто майже всі наявні, в індекс не потрапляють).
 */
export class RunIdempotencyKey1794993774584 implements MigrationInterface {
  name = 'RunIdempotencyKey1794993774584';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "idempotencyKey" character varying(255)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_executions_idempotency_key" ON "executions" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_executions_idempotency_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "idempotencyKey"`,
    );
  }
}
