import { MigrationInterface, QueryRunner } from 'typeorm';
import { ORIGINAL_JOB_USAGE_SQL } from './1795200000000-TenantUsage';

/** Звичайні переходи змінюють лічильники та мінімум одним UPDATE.
 * Вилучення з черги спершу серіалізується на тенанті, щоб пошук нового мінімуму бачив
 * зміни паралельної транзакції, яка щойно звільнила блокування. */
export class JobUsageTransitions1795700000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`CREATE OR REPLACE FUNCTION public.tenant_usage_on_job() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
      DECLARE
        t uuid;
        old_queued boolean := TG_OP <> 'INSERT' AND OLD.status = 'queued';
        new_queued boolean := TG_OP <> 'DELETE' AND NEW.status = 'queued';
        old_running boolean := TG_OP <> 'INSERT' AND OLD.status = 'running';
        new_running boolean := TG_OP <> 'DELETE' AND NEW.status = 'running';
        running_delta integer := new_running::int - old_running::int;
        current_next timestamptz;
        next_run timestamptz;
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
          RAISE EXCEPTION 'jobs.tenantId cannot change';
        END IF;
        t := CASE WHEN TG_OP = 'DELETE' THEN OLD."tenantId" ELSE NEW."tenantId" END;
        IF NOT old_queued THEN
          IF new_queued THEN
            UPDATE public.tenant_usage u SET queued = u.queued + 1, running = u.running + running_delta,
                   "nextRunAt" = LEAST(u."nextRunAt", NEW."runAt"),
                   ready = LEAST(u."nextRunAt", NEW."runAt") <= pg_catalog.clock_timestamp()
             WHERE u."tenantId" = t;
          ELSIF running_delta <> 0 THEN
            UPDATE public.tenant_usage u SET running = u.running + running_delta,
                   ready = COALESCE(u."nextRunAt" <= pg_catalog.clock_timestamp(), false)
             WHERE u."tenantId" = t;
          ELSIF old_running THEN
            -- Зміна runAt активної задачі не змінює лічильники, але вимагає наявного рядка обліку.
            PERFORM 1 FROM public.tenant_usage u WHERE u."tenantId" = t FOR UPDATE;
          ELSE
            RETURN NULL;
          END IF;
        ELSE
          SELECT u."nextRunAt" INTO current_next FROM public.tenant_usage u
           WHERE u."tenantId" = t FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'tenant usage row is missing'; END IF;
          next_run := current_next;
          IF OLD."runAt" <= current_next AND NOT (new_queued AND NEW."runAt" <= OLD."runAt") THEN
            -- Явний LIMIT, а не min(): план зупиняється на першому записі індексу навіть тоді, коли
            -- застаріла статистика оцінює чергу тенанта в один рядок (min() тоді агрегує всю чергу).
            SELECT j."runAt" INTO next_run FROM public.jobs j
             WHERE j."tenantId" = t AND j.status = 'queued'
             ORDER BY j."runAt" LIMIT 1;
          ELSIF new_queued THEN
            next_run := LEAST(current_next, NEW."runAt");
          END IF;
          IF new_queued AND next_run IS NOT DISTINCT FROM current_next THEN RETURN NULL; END IF;
          UPDATE public.tenant_usage u SET queued = u.queued - 1 + new_queued::int,
                 running = u.running + running_delta, "nextRunAt" = next_run,
                 ready = COALESCE(next_run <= pg_catalog.clock_timestamp(), false),
                 "lastClaimedAt" = CASE WHEN new_running THEN pg_catalog.clock_timestamp()
                                        ELSE u."lastClaimedAt" END
           WHERE u."tenantId" = t;
        END IF;
        IF NOT FOUND THEN RAISE EXCEPTION 'tenant usage row is missing'; END IF;
        RETURN NULL;
      END $$`);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      ORIGINAL_JOB_USAGE_SQL.replace(
        'CREATE FUNCTION',
        'CREATE OR REPLACE FUNCTION',
      ),
    );
  }
}
