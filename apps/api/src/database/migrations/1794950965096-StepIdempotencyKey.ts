import { MigrationInterface, QueryRunner } from 'typeorm';

export class StepIdempotencyKey1794950965096 implements MigrationInterface {
  name = 'StepIdempotencyKey1794950965096';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "step_runs" ADD "idempotencyKey" uuid NOT NULL DEFAULT gen_random_uuid()`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_step_runs_idempotency_key" ON "step_runs" ("idempotencyKey") `,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_step_runs_idempotency_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_runs" DROP COLUMN "idempotencyKey"`,
    );
  }
}
