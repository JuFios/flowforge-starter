import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Момент завершення задачі (для видалення завершених задач після терміну зберігання) і частковий
 * індекс під запит очищення. Наявні завершені задачі отримують момент завершення свого виконання;
 * задача без виконання (чи без його моменту завершення) — момент свого створення.
 */
export class JobFinishedAt1794989523846 implements MigrationInterface {
  name = 'JobFinishedAt1794989523846';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "jobs" ADD "finishedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "jobs" j SET "finishedAt" = COALESCE(e."finishedAt", j."createdAt")
         FROM "executions" e
        WHERE e."id" = j."executionId" AND j."status" IN ('done', 'failed', 'dead')`,
    );
    await queryRunner.query(
      `UPDATE "jobs" SET "finishedAt" = "createdAt"
        WHERE "status" IN ('done', 'failed', 'dead') AND "finishedAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_finished" ON "jobs" ("finishedAt") WHERE "status" IN ('done', 'failed', 'dead')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_finished"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "finishedAt"`);
  }
}
