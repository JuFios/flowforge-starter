import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE } from '../../tenancy/roles';
import { terminalOutboxSql } from './1796200000000-NotificationOutbox';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/** Умова попередньої версії тригера: подія лише за ввімкнених сповіщень. */
const ENABLED_ONLY = ' AND s.enabled FOR NO KEY UPDATE';

/**
 * Тригер кінцевого стану створює подію, якщо в тенанта є налаштування сповіщень, увімкнені чи на
 * паузі (`enabled=false`): пауза зупиняє доставку, а не приймання подій.
 */
export function pausedOutboxSql(): string {
  const sql = terminalOutboxSql(true);
  if (!sql.includes(ENABLED_ONLY))
    throw new Error('unexpected outbox trigger body');
  return sql.replace(ENABLED_ONLY, ' FOR NO KEY UPDATE');
}

const PURGE_DELIVERED_SQL = `CREATE OR REPLACE FUNCTION public.purge_delivered_events(p_days integer, p_batch integer)
      RETURNS integer LANGUAGE sql VOLATILE ${DEFINER} AS $$
        WITH batch AS (
          SELECT o.id FROM public.outbox_events o
           WHERE o.status = 'delivered' AND o."deliveredAt" < now() - make_interval(days => p_days)
           ORDER BY o."deliveredAt"
           LIMIT LEAST(GREATEST(p_batch, 1), 10000)
           FOR UPDATE SKIP LOCKED),
        deleted AS (DELETE FROM public.outbox_events o USING batch b WHERE o.id = b.id RETURNING 1)
        SELECT count(*)::integer FROM deleted
      $$`;

/**
 * Пауза замість скасування (README, «Модель гарантій виконання»). Раніше видалення налаштувань
 * переводило недоставлені події в `cancelled`, і без ручного redeliver вони не доходили до
 * отримувача, що суперечить «щонайменше один раз» (ТЗ 3.3.9).
 *
 * - Події лишаються `pending`, доки в тенанта немає налаштувань або вони вимкнені: відправник
 *   захоплює лише тенантів з увімкненими налаштуваннями, тож це пауза. Наступне налаштування того
 *   самого тенанта поновлює доставку з тими самими ID і байтами.
 * - `cancelled` — явна відмова тенанта (`POST …/events/discard`) або скасування зі старої версії;
 *   строк зберігання починається від `cancelledAt`. Старі рядки отримують час міграції.
 * - Спроба, що тривала під час видалення налаштувань, закривається з outcome `paused`, а подія
 *   повертається в `pending`: fencing-токен скинуто, пізня відповідь отримувача нічого не змінить.
 * - Старий runbook використовував видалення налаштувань для відмови від спірної черги.
 *   Причину скасування стара схема не зберігала, тому повернення потребує явного redeliver.
 */
export class OutboxPause1797000000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Як у SerializeOutbox: завершення виконань і зміни налаштувань чекають на перемикання.
    await runner.query(
      'LOCK TABLE public.executions, public.notification_settings, public.outbox_events IN SHARE ROW EXCLUSIVE MODE',
    );
    // Стара транзакція завершення може записати подію вже після початку discard.
    await runner.query(
      `ALTER TABLE public.outbox_events ADD COLUMN "cancelledAt" timestamptz,
        ALTER COLUMN "createdAt" SET DEFAULT clock_timestamp()`,
    );
    await runner.query(`UPDATE public.outbox_events
      SET "cancelledAt" = now()
      WHERE status = 'cancelled'`);
    await runner.query(`ALTER TABLE public.outbox_events ADD CONSTRAINT "CHK_outbox_events_cancelled"
      CHECK ((status = 'cancelled') = ("cancelledAt" IS NOT NULL))`);
    await runner.query(`CREATE INDEX "IDX_outbox_events_cancelled" ON public.outbox_events ("cancelledAt")
      WHERE status = 'cancelled'`);
    await runner.query(pausedOutboxSql());

    await runner.query(`CREATE FUNCTION public.close_paused_attempt() RETURNS trigger
      LANGUAGE plpgsql ${DEFINER} AS $$
      BEGIN
        -- Повернення в pending без налаштувань — пауза під час спроби, а не результат відправника.
        IF NOT EXISTS (SELECT 1 FROM public.notification_settings s WHERE s."tenantId" = NEW."tenantId") THEN
          UPDATE public.outbox_attempts SET outcome = 'paused', "finishedAt" = clock_timestamp()
            WHERE "tenantId" = NEW."tenantId" AND "eventId" = NEW.id AND attempt = NEW.attempts
              AND "finishedAt" IS NULL;
        END IF;
        RETURN NULL;
      END $$`);
    await runner.query(
      `ALTER FUNCTION public.close_paused_attempt() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.close_paused_attempt() FROM PUBLIC',
    );
    await runner.query(`CREATE TRIGGER close_paused_attempt AFTER UPDATE OF status ON public.outbox_events
      FOR EACH ROW WHEN (OLD.status = 'sending' AND NEW.status = 'pending')
      EXECUTE FUNCTION public.close_paused_attempt()`);

    // Очищення доставлених і скасованих подій після строку зберігання.
    await runner.query(`CREATE OR REPLACE FUNCTION public.purge_delivered_events(p_days integer, p_batch integer)
      RETURNS integer LANGUAGE sql VOLATILE ${DEFINER} AS $$
        WITH delivered AS (
          SELECT o.id FROM public.outbox_events o
           WHERE o.status = 'delivered' AND o."deliveredAt" < now() - make_interval(days => p_days)
           ORDER BY o."deliveredAt"
           LIMIT LEAST(GREATEST(p_batch, 1), 10000)
           FOR UPDATE SKIP LOCKED),
        cancelled AS (
          SELECT o.id FROM public.outbox_events o
           WHERE o.status = 'cancelled' AND o."cancelledAt" < now() - make_interval(days => p_days)
           ORDER BY o."cancelledAt"
           LIMIT LEAST(GREATEST(p_batch, 1), 10000)
           FOR UPDATE SKIP LOCKED),
        batch AS (SELECT id FROM delivered UNION ALL SELECT id FROM cancelled),
        deleted AS (DELETE FROM public.outbox_events o USING batch b WHERE o.id = b.id RETURNING 1)
        SELECT count(*)::integer FROM deleted
      $$`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'LOCK TABLE public.executions, public.notification_settings, public.outbox_events IN SHARE ROW EXCLUSIVE MODE',
    );
    await runner.query(PURGE_DELIVERED_SQL);
    await runner.query(
      'DROP TRIGGER close_paused_attempt ON public.outbox_events',
    );
    await runner.query('DROP FUNCTION public.close_paused_attempt()');
    await runner.query(terminalOutboxSql(true));
    await runner.query('DROP INDEX public."IDX_outbox_events_cancelled"');
    await runner.query(
      'ALTER TABLE public.outbox_events DROP CONSTRAINT "CHK_outbox_events_cancelled"',
    );
    await runner.query(
      `ALTER TABLE public.outbox_events DROP COLUMN "cancelledAt",
        ALTER COLUMN "createdAt" SET DEFAULT now()`,
    );
  }
}
