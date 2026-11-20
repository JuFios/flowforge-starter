import { MigrationInterface, QueryRunner } from 'typeorm';

const filters: Record<string, string> = {
  tenant: '',
  status: 'status,',
  workflow: '"workflowId",',
  workflow_status: '"workflowId", status,',
};

export class ExecutionPages1796600000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const [name, columns] of Object.entries(filters))
      await runner.query(
        `CREATE INDEX "IDX_execution_page_${name}" ON public.executions ("tenantId", ${columns} "createdAt", id)`,
      );
    await runner.query('DROP INDEX public."IDX_5b883cccfe558d00b8a9319d93"');
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'CREATE INDEX "IDX_5b883cccfe558d00b8a9319d93" ON public.executions ("tenantId","createdAt")',
    );
    for (const name of Object.keys(filters))
      await runner.query(`DROP INDEX public."IDX_execution_page_${name}"`);
  }
}
