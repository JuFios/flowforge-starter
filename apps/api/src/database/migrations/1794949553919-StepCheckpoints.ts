import { MigrationInterface, QueryRunner } from 'typeorm';

export class StepCheckpoints1794949553919 implements MigrationInterface {
  name = 'StepCheckpoints1794949553919';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_26dad67b58b319f33770f4adce"`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_runs" ADD "attempts" integer NOT NULL DEFAULT '1'`,
    );
    await queryRunner.query(
      `ALTER TABLE "step_runs" ADD "finishedAt" TIMESTAMP WITH TIME ZONE`,
    );
    // Стартовий код створював новий рядок на кожну спробу кроку. Лишаємо по одному рядку на
    // крок — успішний, а серед рівних найпізніший; attempts = скільки спроб було.
    await queryRunner.query(`
            UPDATE step_runs s SET attempts = r.n
              FROM (SELECT id,
                           row_number() OVER w AS rn,
                           count(*) OVER (PARTITION BY "executionId", "stepIndex") AS n
                      FROM step_runs
                    WINDOW w AS (PARTITION BY "executionId", "stepIndex"
                                 ORDER BY (status = 'succeeded') DESC, "startedAt" DESC, id)) r
             WHERE s.id = r.id AND r.rn = 1`);
    await queryRunner.query(`
            DELETE FROM step_runs s
             USING (SELECT id,
                           row_number() OVER (PARTITION BY "executionId", "stepIndex"
                                              ORDER BY (status = 'succeeded') DESC, "startedAt" DESC, id) AS rn
                      FROM step_runs) r
             WHERE s.id = r.id AND r.rn > 1`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_step_runs_execution_step" ON "step_runs" ("executionId", "stepIndex") `,
    );
  }

  /** Згорнуті дублікати спроб не відновлюються: down лише повертає схему. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."UQ_step_runs_execution_step"`,
    );
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "finishedAt"`);
    await queryRunner.query(`ALTER TABLE "step_runs" DROP COLUMN "attempts"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_26dad67b58b319f33770f4adce" ON "step_runs" ("executionId", "stepIndex") `,
    );
  }
}
