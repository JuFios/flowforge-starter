import { MigrationInterface, QueryRunner } from 'typeorm';

export class QueueLease1794949287178 implements MigrationInterface {
  name = 'QueueLease1794949287178';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f0517eec3f63f617ee5138edeb"`,
    );
    await queryRunner.query(`ALTER TABLE "jobs" ADD "lockToken" uuid`);
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_lease" ON "jobs" ("lockedUntil") WHERE "status" = 'running'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_jobs_claim" ON "jobs" ("runAt") WHERE "status" = 'queued'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_claim"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_jobs_lease"`);
    await queryRunner.query(`ALTER TABLE "jobs" DROP COLUMN "lockToken"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_f0517eec3f63f617ee5138edeb" ON "jobs" ("status", "runAt") `,
    );
  }
}
