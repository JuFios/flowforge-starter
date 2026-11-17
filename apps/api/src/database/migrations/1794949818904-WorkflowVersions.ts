import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkflowVersions1794949818904 implements MigrationInterface {
  name = 'WorkflowVersions1794949818904';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "workflow_versions" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "workflowId" uuid NOT NULL, "tenantId" uuid NOT NULL, "version" integer NOT NULL, "steps" jsonb NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_workflow_versions_workflow_version" UNIQUE ("workflowId", "version"), CONSTRAINT "PK_a84eb8dc6065f33ce4b1447955f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD "workflowVersionId" uuid`,
    );
    // Наявні workflow: поточні кроки стають версією з поточним номером.
    await queryRunner.query(`
            INSERT INTO workflow_versions ("workflowId", "tenantId", version, steps, "createdAt")
            SELECT id, "tenantId", version, steps, "createdAt" FROM workflows`);
    // Наявні виконання: до міграції воркер і так брав поточні кроки workflow, тож прив'язка
    // до поточної версії зберігає їхню поведінку.
    await queryRunner.query(`
            UPDATE executions e SET "workflowVersionId" = v.id
              FROM workflow_versions v WHERE v."workflowId" = e."workflowId"`);
    // Незавершені виконання вже видалених workflow виконати неможливо (стартовий код
    // повторював їх, доки не вичерпає спроби): завершуємо їх явно разом із задачами.
    const orphanError = 'workflow was deleted before this execution could run';
    await queryRunner.query(
      `UPDATE jobs SET status = 'failed', "lastError" = $1,
                    "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
              WHERE status IN ('queued', 'running')
                AND "executionId" IN (SELECT id FROM executions
                                       WHERE "workflowVersionId" IS NULL
                                         AND status NOT IN ('succeeded', 'failed'))`,
      [orphanError],
    );
    await queryRunner.query(
      `UPDATE executions SET status = 'failed', error = $1, "finishedAt" = now()
              WHERE "workflowVersionId" IS NULL AND status NOT IN ('succeeded', 'failed')`,
      [orphanError],
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "CHK_executions_version_snapshot" CHECK ("workflowVersionId" IS NOT NULL OR "status" IN ('succeeded', 'failed'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" ADD CONSTRAINT "FK_d7a80c20eaa0c1916248aeaa579" FOREIGN KEY ("workflowVersionId") REFERENCES "workflow_versions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "FK_d7a80c20eaa0c1916248aeaa579"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP CONSTRAINT "CHK_executions_version_snapshot"`,
    );
    await queryRunner.query(
      `ALTER TABLE "executions" DROP COLUMN "workflowVersionId"`,
    );
    await queryRunner.query(`DROP TABLE "workflow_versions"`);
  }
}
