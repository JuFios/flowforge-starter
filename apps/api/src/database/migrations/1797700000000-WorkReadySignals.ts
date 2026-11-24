import { MigrationInterface, QueryRunner } from 'typeorm';

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
      'DROP FUNCTION public.notify_jobs_ready(), public.notify_outbox_ready()',
    );
  }
}
