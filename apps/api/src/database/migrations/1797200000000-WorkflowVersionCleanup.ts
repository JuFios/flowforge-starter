import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

export class WorkflowVersionCleanup1797200000000 implements MigrationInterface {
  name = 'WorkflowVersionCleanup1797200000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE INDEX "IDX_executions_workflow_version_tenant"
      ON public.executions ("workflowVersionId", "tenantId")`);
    await runner.query(`CREATE TABLE public.workflow_version_cleanup (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      cursor_id uuid, end_id uuid,
      CHECK (cursor_id IS NULL OR (end_id IS NOT NULL AND cursor_id < end_id))
    )`);
    await runner.query(
      'INSERT INTO public.workflow_version_cleanup DEFAULT VALUES',
    );
    await runner.query(
      `GRANT SELECT, UPDATE ON public.workflow_version_cleanup TO ${SYSTEM_ROLE}`,
    );
    await runner.query(`CREATE FUNCTION public.purge_workflow_versions()
      RETURNS TABLE(deleted integer, more boolean)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        scan_after uuid;
        scan_end uuid;
        page uuid[];
        locked uuid[];
        last_id uuid;
      BEGIN
        SELECT cursor_id, end_id INTO scan_after, scan_end
          FROM public.workflow_version_cleanup WHERE singleton FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 0, true;
          RETURN;
        END IF;
        IF scan_end IS NULL THEN
          SELECT id INTO scan_end FROM public.workflow_versions ORDER BY id DESC LIMIT 1;
        END IF;
        SELECT ARRAY(
          SELECT v.id FROM public.workflow_versions v
          WHERE v.id >= COALESCE(scan_after, '00000000-0000-0000-0000-000000000000'::uuid)
            AND v.id IS DISTINCT FROM scan_after AND v.id <= scan_end
          ORDER BY v.id LIMIT 500
        ) INTO page;

        -- Запуск читає поточну версію під блокуванням workflow; редагування та видалення
        -- не можуть зробити її застарілою до завершення запуску. Для FK додатково тримаємо
        -- блокування версій і звіряємо посилання ще раз свіжим оператором READ COMMITTED.
        SELECT ARRAY(
          SELECT v.id FROM public.workflow_versions v
          WHERE v.id = ANY(page)
            AND NOT EXISTS (
              SELECT FROM public.workflows w
              WHERE w.id = v."workflowId" AND w."tenantId" = v."tenantId" AND w.version = v.version)
            AND NOT EXISTS (
              SELECT FROM public.executions e
              WHERE e."workflowVersionId" = v.id AND e."tenantId" = v."tenantId")
          ORDER BY v.id FOR UPDATE OF v SKIP LOCKED
        ) INTO locked;
        DELETE FROM public.workflow_versions v
        WHERE v.id = ANY(locked)
          AND NOT EXISTS (
            SELECT FROM public.workflows w
            WHERE w.id = v."workflowId" AND w."tenantId" = v."tenantId" AND w.version = v.version)
          AND NOT EXISTS (
            SELECT FROM public.executions e
            WHERE e."workflowVersionId" = v.id AND e."tenantId" = v."tenantId");
        GET DIAGNOSTICS deleted = ROW_COUNT;

        last_id := page[cardinality(page)];
        more := cardinality(page) = 500 AND last_id < scan_end;
        UPDATE public.workflow_version_cleanup
        SET cursor_id = CASE WHEN more THEN last_id END,
            end_id = CASE WHEN more THEN scan_end END
        WHERE singleton;
        RETURN NEXT;
      END $$`);
    await runner.query(
      `ALTER FUNCTION public.purge_workflow_versions() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.purge_workflow_versions() FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.purge_workflow_versions() TO ${WORKER_ROLE}`,
    );
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION public.purge_workflow_versions()');
    await runner.query('DROP TABLE public.workflow_version_cleanup');
    await runner.query(
      'DROP INDEX public."IDX_executions_workflow_version_tenant"',
    );
  }
}
