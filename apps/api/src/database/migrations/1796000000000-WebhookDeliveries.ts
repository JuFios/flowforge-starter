import { MigrationInterface, QueryRunner } from 'typeorm';
import { API_ROLE } from '../../tenancy/roles';

export class WebhookDeliveries1796000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE tenants
      ADD "webhookKeyId" uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD "nextWebhookKeyId" uuid,
      ADD "nextWebhookSecret" varchar,
      ADD CONSTRAINT "CHK_webhook_key_pair" CHECK (
        ("nextWebhookKeyId" IS NULL) = ("nextWebhookSecret" IS NULL)
        AND "webhookKeyId" IS DISTINCT FROM "nextWebhookKeyId")`);
    await runner.query(
      'ALTER TABLE workflows ADD CONSTRAINT "UQ_workflows_id_tenant" UNIQUE (id, "tenantId")',
    );
    await runner.query(`CREATE TABLE webhook_deliveries (
      "workflowId" uuid NOT NULL, "tenantId" uuid NOT NULL, "deliveryId" varchar(128) NOT NULL,
      "bodyHash" bytea NOT NULL CHECK (octet_length("bodyHash") = 32),
      "executionId" uuid NOT NULL, PRIMARY KEY ("tenantId", "workflowId", "deliveryId"),
      FOREIGN KEY ("workflowId","tenantId") REFERENCES workflows(id,"tenantId") ON DELETE CASCADE
    )`);
    await runner.query(
      'ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY',
    );
    await runner.query(
      'ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY',
    );
    await runner.query(
      `CREATE POLICY tenant_isolation ON webhook_deliveries USING ("tenantId" = public.app_current_tenant()) WITH CHECK ("tenantId" = public.app_current_tenant())`,
    );
    await runner.query(
      `GRANT SELECT, INSERT ON webhook_deliveries TO ${API_ROLE}`,
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    const rows: unknown[] = await runner.query(
      'SELECT 1 FROM webhook_deliveries LIMIT 1',
    );
    const rotating: unknown[] = await runner.query(
      'SELECT 1 FROM tenants WHERE "nextWebhookKeyId" IS NOT NULL LIMIT 1',
    );
    if (rows.length || rotating.length)
      throw new Error(
        'webhook deliveries or active rotations prevent a lossless downgrade',
      );
    await runner.query('DROP TABLE webhook_deliveries');
    await runner.query(
      'ALTER TABLE workflows DROP CONSTRAINT "UQ_workflows_id_tenant"',
    );
    await runner.query(
      'ALTER TABLE tenants DROP COLUMN "webhookKeyId", DROP COLUMN "nextWebhookKeyId", DROP COLUMN "nextWebhookSecret"',
    );
  }
}
