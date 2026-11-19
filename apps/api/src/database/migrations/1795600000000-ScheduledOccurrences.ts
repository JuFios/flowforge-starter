import { MigrationInterface, QueryRunner } from 'typeorm';
export class ScheduledOccurrences1795600000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE public.executions ADD COLUMN "scheduledAt" timestamptz',
    );
    await runner.query(
      `CREATE UNIQUE INDEX "UQ_executions_scheduled" ON public.executions ("tenantId","workflowId","scheduledAt") WHERE "scheduledAt" IS NOT NULL`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE public.executions DROP COLUMN "scheduledAt"',
    );
  }
}
