import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLE } from '../../tenancy/roles';

export class CloseCancelledAttempts1796400000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE FUNCTION public.close_cancelled_attempt() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      BEGIN
        UPDATE public.outbox_attempts SET outcome='cancelled', "finishedAt"=clock_timestamp()
          WHERE "tenantId"=NEW."tenantId" AND "eventId"=NEW.id AND attempt=NEW.attempts AND "finishedAt" IS NULL;
        RETURN NULL;
      END $$`);
    await runner.query(
      `ALTER FUNCTION public.close_cancelled_attempt() OWNER TO ${SYSTEM_ROLE}`,
    );
    await runner.query(
      'REVOKE ALL ON FUNCTION public.close_cancelled_attempt() FROM PUBLIC',
    );
    await runner.query(`CREATE TRIGGER close_cancelled_attempt AFTER UPDATE OF status ON public.outbox_events
      FOR EACH ROW WHEN (NEW.status='cancelled' AND OLD.status='sending')
      EXECUTE FUNCTION public.close_cancelled_attempt()`);
    // Закриваємо також давніші покинуті спроби подій, які вже встигли повторно доставити.
    await runner.query(`UPDATE public.outbox_attempts a SET outcome='interrupted', "finishedAt"=clock_timestamp()
      FROM public.outbox_events e WHERE a."eventId"=e.id AND a."finishedAt" IS NULL
        AND (e.status <> 'sending' OR a.attempt <> e.attempts)`);
    await runner.query(`UPDATE public.workflows SET "nextFireAt"=NULL, "scheduleError"=NULL, "scheduleBlockedSince"=NULL
      WHERE (cron IS NULL OR NOT enabled) AND ("nextFireAt" IS NOT NULL OR "scheduleError" IS NOT NULL OR "scheduleBlockedSince" IS NOT NULL)`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      'DROP TRIGGER close_cancelled_attempt ON public.outbox_events',
    );
    await runner.query('DROP FUNCTION public.close_cancelled_attempt()');
  }
}
