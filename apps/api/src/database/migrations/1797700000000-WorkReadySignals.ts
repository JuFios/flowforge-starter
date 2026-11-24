import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE, WORKER_ROLE } from '../../tenancy/roles';

/** Найдовша пауза, яку повертає next_due_work (доба): далі однаково опитує черговий цикл. */
const MAX_DUE_MS = 86_400_000;

/** Мілісекунди від годинника БД до моменту `at`, обмежені [1, MAX_DUE_MS]. */
const msUntil = (at: string) =>
  `LEAST(${MAX_DUE_MS}, GREATEST(1, ceil(EXTRACT(EPOCH FROM (${at} - pg_catalog.clock_timestamp())) * 1000)))::integer`;

/**
 * Підказки воркерам про нову готову роботу (docs/architecture.md, «Черговий цикл і пробудження»).
 * Сповіщення лише на перехід «у тенанта немає готової роботи → є», а не на кожну зміну черги: під
 * сталим навантаженням тенант уже готовий, тож сповіщень немає й коміти не серіалізуються на
 * глобальному блокуванні черги сповіщень Postgres. Пропущене сповіщення нічого не ламає: черговий
 * цикл воркера опитує чергу з тим самим інтервалом, що й без сповіщень.
 *
 * - `ff_jobs_ready`: облік тенанта (`tenant_usage`) став готовим разом зі зміною `nextRunAt`, тобто
 *   з'явилась задача, готова раніше за наявні (постановка, повернення в чергу). Готовність за
 *   плином часу (повтор із backoff, пробудження `delay`) без зміни `nextRunAt` сповіщення не дає —
 *   її виявляє опитування, як і раніше.
 * - `ff_outbox_ready`: строк `dueAt` налаштувань сповіщень тенанта знизився до «вже настав» з
 *   відсутнього чи майбутнього (нова подія за ввімкнених налаштувань).
 * - `next_due_work()`: мілісекунди до найближчої відкладеної роботи (задача, що дозріє в
 *   ненасиченого тенанта, — за індексом IDX_tenant_usage_maturing; подія з майбутнім `dueAt` — за
 *   IDX_notification_settings_due), за годинником БД. Черговий цикл засинає не довше, тож повтор із
 *   backoff і пробудження `delay` беруться в момент строку, а не на наступному опитуванні. Лише
 *   кількості мілісекунд, без ідентифікаторів тенантів.
 */
export class WorkReadySignals1797700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    for (const [fn, channel] of [
      ['notify_jobs_ready', 'ff_jobs_ready'],
      ['notify_outbox_ready', 'ff_outbox_ready'],
    ] as const) {
      await runner.query(`CREATE FUNCTION public.${fn}() RETURNS trigger
        LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
        BEGIN PERFORM pg_catalog.pg_notify('${channel}', 'ready'); RETURN NULL; END $$`);
      await runner.query(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC`);
    }
    await runner.query(`CREATE FUNCTION public.next_due_work()
      RETURNS TABLE ("jobsMs" integer, "outboxMs" integer)
      LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
        SELECT
          (SELECT ${msUntil('u."nextRunAt"')} FROM public.tenant_usage u
            WHERE NOT u.ready AND u."nextRunAt" IS NOT NULL AND u.running < u."maxRunning"
              AND u."nextRunAt" > pg_catalog.clock_timestamp()
            ORDER BY u."nextRunAt" LIMIT 1),
          (SELECT ${msUntil('n."dueAt"')} FROM public.notification_settings n
            WHERE n.enabled AND n."dueAt" > pg_catalog.clock_timestamp()
            ORDER BY n."dueAt" LIMIT 1)
      $$`);
    await runner.query(
      `ALTER FUNCTION public.next_due_work() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.next_due_work() FROM PUBLIC',
    );
    await runner.query(
      `GRANT EXECUTE ON FUNCTION public.next_due_work() TO ${WORKER_ROLE}`,
    );
    await runner.query(`CREATE TRIGGER jobs_ready AFTER UPDATE OF ready, "nextRunAt" ON public.tenant_usage
      FOR EACH ROW WHEN (NEW.ready AND NOT OLD.ready AND NEW."nextRunAt" IS DISTINCT FROM OLD."nextRunAt")
      EXECUTE FUNCTION public.notify_jobs_ready()`);
    await runner.query(`CREATE TRIGGER outbox_ready AFTER UPDATE OF "dueAt", enabled ON public.notification_settings
      FOR EACH ROW WHEN (NEW.enabled AND NEW."dueAt" <= now()
                         AND (NOT OLD.enabled OR OLD."dueAt" IS NULL OR OLD."dueAt" > now()))
      EXECUTE FUNCTION public.notify_outbox_ready()`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER outbox_ready ON public.notification_settings',
    );
    await runner.query('DROP TRIGGER jobs_ready ON public.tenant_usage');
    await runner.query(
      'DROP FUNCTION public.notify_jobs_ready(), public.notify_outbox_ready(), public.next_due_work()',
    );
  }
}
