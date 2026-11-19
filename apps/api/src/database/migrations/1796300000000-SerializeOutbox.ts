import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';
import { terminalOutboxSql } from './1796200000000-NotificationOutbox';

const FINISH =
  'public.finish_outbox_event(uuid,uuid,double precision,text,integer)';
export class SerializeOutbox1796300000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Спершу зупиняємо переходи execution, потім зміни конфігурації й спроб доставки.
    await runner.query(
      'LOCK TABLE public.executions, public.notification_settings, public.outbox_events IN SHARE ROW EXCLUSIVE MODE',
    );
    // Короткий успадкований запис з майбутньою підказкою має бути видимим оператору одразу.
    await runner.query(`WITH schedules AS (
      SELECT id, regexp_replace(cron,'^[[:space:]]+|[[:space:]]+$','','g') AS source
      FROM public.workflows WHERE cron IS NOT NULL)
      UPDATE public.workflows w SET "nextFireAt"=NULL,
        "scheduleError"='cron requires five or six fields or a supported alias'
      FROM schedules s WHERE w.id=s.id AND s.source NOT IN ('@yearly','@monthly','@weekly','@daily','@hourly')
        AND cardinality(regexp_split_to_array(s.source,'[[:space:]]+')) NOT IN (5,6)`);
    await runner.query(terminalOutboxSql(true));
    await runner.query(`CREATE FUNCTION public.finish_outbox_event(
      event_id uuid, token uuid, delay_seconds double precision, result text, http_status integer
    ) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE tenant uuid := public.app_current_tenant(); retry_at timestamptz;
      BEGIN
        PERFORM 1 FROM public.notification_settings WHERE "tenantId"=tenant FOR NO KEY UPDATE;
        IF NOT FOUND THEN RETURN false; END IF;
        UPDATE public.outbox_events SET
          status=CASE WHEN result='delivered' THEN 'delivered' ELSE 'pending' END,
          "leaseToken"=NULL, "leaseUntil"=NULL,
          "nextAttemptAt"=CASE WHEN result='delivered' THEN "nextAttemptAt" ELSE clock_timestamp()+make_interval(secs=>delay_seconds) END,
          "deliveredAt"=CASE WHEN result='delivered' THEN clock_timestamp() END,
          "lastError"=NULLIF(result,'delivered'), "lastStatus"=http_status
        WHERE id=event_id AND "tenantId"=tenant AND "leaseToken"=token AND status='sending'
        RETURNING "nextAttemptAt" INTO retry_at;
        IF NOT FOUND THEN RETURN false; END IF;
        IF result <> 'delivered' THEN
          UPDATE public.notification_settings SET "dueAt"=retry_at WHERE "tenantId"=tenant
            AND ("dueAt" IS NULL OR "dueAt">retry_at);
        END IF;
        RETURN true;
      END $$`);
    await runner.query(`ALTER FUNCTION ${FINISH} OWNER TO ${SYSTEM_ROLE}`);
    await runner.query(`REVOKE ALL ON FUNCTION ${FINISH} FROM PUBLIC`);
    await runner.query(`GRANT EXECUTE ON FUNCTION ${FINISH} TO ${WORKER_ROLE}`);
    // Відновлюємо підказки для наявних спроб до запуску нової версії воркера.
    await runner.query(`UPDATE public.notification_settings s SET "dueAt"=LEAST(
      (SELECT min("nextAttemptAt") FROM public.outbox_events WHERE "tenantId"=s."tenantId" AND status='pending'),
      (SELECT min("leaseUntil") FROM public.outbox_events WHERE "tenantId"=s."tenantId" AND status='sending'))`);
    await runner.query(`UPDATE public.outbox_events e SET status='cancelled', "leaseToken"=NULL, "leaseUntil"=NULL
      WHERE status IN ('pending','sending') AND NOT EXISTS (
        SELECT FROM public.notification_settings s WHERE s."tenantId"=e."tenantId")`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(`DROP FUNCTION ${FINISH}`);
    await runner.query(terminalOutboxSql(false));
  }
}
