import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';
import { PURGE_WORKFLOW_VERSIONS_V1 } from './1797200000000-WorkflowVersionCleanup';

/**
 * Очищення версій workflow з паузою між проходами (docs/operations.md, «Конфігурація»). Курсор
 * проходу спільний для воркерів, а `more = false` отримує лише той, хто забрав останню сторінку.
 * Решта, чия попередня відповідь була `more = true`, наступним викликом починали новий прохід, тож
 * N воркерів робили N проходів за цикл. Тепер новий прохід (курсора немає) не починається, доки від
 * завершення попереднього не мине `p_min_gap_ms`; такий виклик повертає `(0, false)`.
 */
const PURGE_WORKFLOW_VERSIONS_V2 = `CREATE FUNCTION public.purge_workflow_versions(p_min_gap_ms integer)
      RETURNS TABLE(deleted integer, more boolean)
      LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        scan_after uuid;
        scan_end uuid;
        scan_finished timestamptz;
        page uuid[];
        locked uuid[];
        last_id uuid;
      BEGIN
        IF p_min_gap_ms IS NULL OR p_min_gap_ms < 0 THEN
          RAISE EXCEPTION 'minimum gap between cleanup passes must be a non-negative number of milliseconds';
        END IF;
        SELECT cursor_id, end_id, finished_at INTO scan_after, scan_end, scan_finished
          FROM public.workflow_version_cleanup WHERE singleton FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN
          RETURN QUERY SELECT 0, true;
          RETURN;
        END IF;
        IF scan_after IS NULL AND scan_finished IS NOT NULL
           AND scan_finished > pg_catalog.clock_timestamp()
                               - pg_catalog.make_interval(secs => p_min_gap_ms / 1000.0) THEN
          RETURN QUERY SELECT 0, false;
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
            end_id = CASE WHEN more THEN scan_end END,
            finished_at = CASE WHEN more THEN finished_at ELSE pg_catalog.clock_timestamp() END
        WHERE singleton;
        RETURN NEXT;
      END $$`;

async function grant(runner: QueryRunner, signature: string): Promise<void> {
  await runner.query(
    `ALTER FUNCTION public.${signature} OWNER TO ${SYSTEM_ROLE}`,
  );
  await runner.query(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC`);
  await runner.query(
    `GRANT EXECUTE ON FUNCTION public.${signature} TO ${WORKER_ROLE}`,
  );
}

export class WorkflowVersionCleanupPace1797300000000 implements MigrationInterface {
  name = 'WorkflowVersionCleanupPace1797300000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE public.workflow_version_cleanup ADD COLUMN finished_at timestamptz',
    );
    await runner.query('DROP FUNCTION public.purge_workflow_versions()');
    await runner.query(PURGE_WORKFLOW_VERSIONS_V2);
    await grant(runner, 'purge_workflow_versions(integer)');
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP FUNCTION public.purge_workflow_versions(integer)');
    await runner.query(
      'ALTER TABLE public.workflow_version_cleanup DROP COLUMN finished_at',
    );
    await runner.query(PURGE_WORKFLOW_VERSIONS_V1);
    await grant(runner, 'purge_workflow_versions()');
  }
}
