import { MigrationInterface, QueryRunner } from 'typeorm';

export class DurableTimers1794950256356 implements MigrationInterface {
  name = 'DurableTimers1794950256356';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "step_runs" ADD "wakeAt" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "wakeAt"`);
  }
}
