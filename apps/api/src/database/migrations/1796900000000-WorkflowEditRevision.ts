import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowEditRevision1796900000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE public.workflows ADD COLUMN "editRevision" bigint NOT NULL DEFAULT 1`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      `ALTER TABLE public.workflows DROP COLUMN "editRevision"`,
    );
  }
}
