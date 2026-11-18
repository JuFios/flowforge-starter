import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Індекси для повтору виконання (задача за виконанням) і очищення історії (завершені виконання
 * за моментом завершення).
 */
export class HistoryIndexes1794993930872 implements MigrationInterface {
  name = 'HistoryIndexes1794993930872';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_executions_finished" ON "executions" ("finishedAt") WHERE "status" IN ('succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_execution" ON "jobs" ("executionId") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_execution"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_executions_finished"`);
  }
}
