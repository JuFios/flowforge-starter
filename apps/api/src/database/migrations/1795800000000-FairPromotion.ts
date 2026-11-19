import { MigrationInterface, QueryRunner } from 'typeorm';
import { claimJobSql } from './1795200000000-TenantUsage';

/** Скільки дозрілих тенантів просуває одна пачка промоції. */
export const PROMOTE_BATCH = 128;
/** Скільки пачок промоції робить одне захоплення, перш ніж повернути busy. */
export const PROMOTE_ROUNDS = 8;
/** Найбільше дозрілих тенантів, яких одне захоплення просуває до вибору. */
export const PROMOTE_BUDGET = PROMOTE_BATCH * PROMOTE_ROUNDS;
/** Скільки тенантів-кандидатів без готової задачі одне захоплення пропускає, перш ніж здатися. */
const CLAIM_TENANTS = 10;

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/**
 * Справедливе захоплення (README, 3.3.5), що виконує гарантію незалежно від кількості тенантів,
 * які дозріли одночасно:
 *  1. промоція доходить до кінця, перш ніж обирати: усі тенанти, чия найраніша задача настала до
 *     початку оператора, стають готовими пачками по PROMOTE_BATCH. Інакше тенант B за 64 іншими
 *     дозрілими тенантами потрапляв би до вибору лише через кілька захоплень, а швидкий тенант A
 *     тим часом обслуговувався б кілька разів. Якщо дозрілих більше за бюджет одного оператора
 *     (PROMOTE_BUDGET), захоплення нікого не обирає й повертає busy: промоцію продовжать наступні
 *     захоплення (кожне просуває свою частину — SKIP LOCKED), а вибір відбудеться, коли порядок
 *     усіх дозрілих відомий. Бюджет обмежує тривалість одного оператора, тож навіть сплеск зі
 *     100 000 тенантів не впирається в statement_timeout і не відкочується без прогресу;
 *  2. вибір тенанта й задачі — як раніше (SKIP LOCKED на обох рівнях);
 *  3. готова задача, яку пропустив SKIP LOCKED (її рядок тримає коротка транзакція), — ознака
 *     busy, а не порожньої черги: воркер повторить за мить, а не через повний інтервал опитування.
 */
export function fairClaimJobSql(revision: 1 | 2 = 1): string {
  const due = 'pg_catalog.statement_timestamp()';
  // Дозрілий тенант, якого промоція не просунула (його рядок тримала інша транзакція — SKIP LOCKED,
  // або він дозрів між пачками). Ревізія 2 (міграція ClaimBusyReport) враховує його в ознаці busy:
  // інакше воркер вважав би чергу порожньою й чекав повний інтервал опитування.
  const unpromoted = `EXISTS (SELECT 1 FROM public.tenant_usage m
                                WHERE NOT m.ready AND m.running < m."maxRunning"
                                  AND m."nextRunAt" <= ${due})`;
  // Бюджет вичерпано рівно на останньому раунді: busy лише якщо дозрілі ще лишились (ревізія 2).
  const budgetSpent =
    revision === 1
      ? `round = ${PROMOTE_ROUNDS}`
      : `round = ${PROMOTE_ROUNDS} AND ${unpromoted}`;
  const alsoUnpromoted = revision === 1 ? '' : ` OR ${unpromoted}`;
  return `CREATE OR REPLACE FUNCTION public.claim_job(p_worker text, p_lease_ms integer)
        RETURNS SETOF public.claimed_job
        LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
        DECLARE
          t uuid;
          j public.jobs;
          tried uuid[] := '{}';
          promoted uuid[];
          repaired integer := 0;
          skipped boolean := false;
          lease interval;
        BEGIN
          IF p_worker IS NULL OR pg_catalog.length(p_worker) NOT BETWEEN 1 AND 200
             OR p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 100 AND 3600000 THEN
            RAISE EXCEPTION 'invalid claim arguments';
          END IF;
          lease := pg_catalog.make_interval(secs => p_lease_ms / 1000.0);

          FOR round IN 1..${PROMOTE_ROUNDS} LOOP
            promoted := ARRAY(SELECT m."tenantId" FROM public.tenant_usage m
                               WHERE NOT m.ready AND m.running < m."maxRunning"
                                 AND m."nextRunAt" <= ${due}
                               ORDER BY m."nextRunAt"
                               LIMIT ${PROMOTE_BATCH}
                               FOR UPDATE SKIP LOCKED);
            UPDATE public.tenant_usage u SET ready = true
             WHERE u."tenantId" = ANY (promoted)
               AND NOT u.ready AND u."nextRunAt" <= ${due};
            EXIT WHEN pg_catalog.cardinality(promoted) < ${PROMOTE_BATCH};
            IF ${budgetSpent} THEN
              -- Дозрілих більше за бюджет: порядок решти ще невідомий, тож нікого не обираємо.
              RETURN QUERY SELECT NULL::public.jobs, NULL::timestamptz, repaired, true;
              RETURN;
            END IF;
          END LOOP;

          FOR attempt IN 1..${CLAIM_TENANTS} LOOP
            SELECT u."tenantId" INTO t FROM public.tenant_usage u
             WHERE u.ready AND u.running < u."maxRunning" AND u."tenantId" <> ALL (tried)
             ORDER BY u.running, u."lastClaimedAt", u."tenantId"
             LIMIT 1
             FOR UPDATE SKIP LOCKED;
            IF t IS NULL THEN
              -- Кандидати є, але їхні рядки тримають інші транзакції, або готову задачу вже
              -- пропущено як зайняту: busy — воркер повторить за мить, не чекаючи на рядок.
              RETURN QUERY SELECT NULL::public.jobs, NULL::timestamptz, repaired,
                skipped OR EXISTS (SELECT 1 FROM public.tenant_usage u
                                    WHERE u.ready AND u.running < u."maxRunning"
                                      AND u."tenantId" <> ALL (tried))${alsoUnpromoted};
              RETURN;
            END IF;

            UPDATE public.jobs
               SET status = 'running', "lockedBy" = p_worker,
                   "lockToken" = pg_catalog.gen_random_uuid(),
                   "lockedUntil" = pg_catalog.clock_timestamp() + lease,
                   attempts = attempts + 1
             WHERE id = (SELECT q.id FROM public.jobs q
                          WHERE q."tenantId" = t AND q.status = 'queued'
                            AND q."runAt" <= ${due}
                          ORDER BY q."runAt"
                          LIMIT 1
                          FOR UPDATE SKIP LOCKED)
               AND "tenantId" = t
            RETURNING * INTO j;
            IF FOUND THEN
              RETURN QUERY SELECT j, pg_catalog.clock_timestamp(), repaired, false;
              RETURN;
            END IF;
            IF EXISTS (SELECT 1 FROM public.jobs q
                        WHERE q."tenantId" = t AND q.status = 'queued'
                          AND q."runAt" <= ${due}) THEN
              -- Готова задача є, але її рядок зайнятий: облік правильний, задача звільниться.
              skipped := true;
            ELSE
              -- Готових задач немає зовсім (а не лише зайнятих): облік розійшовся — перерахувати.
              UPDATE public.tenant_usage u
                 SET queued = a.queued, running = a.running, "nextRunAt" = a.next,
                     ready = COALESCE(a.next <= ${due}, false)
                FROM (SELECT count(*) FILTER (WHERE q.status = 'queued')::int AS queued,
                             count(*) FILTER (WHERE q.status = 'running')::int AS running,
                             min(q."runAt") FILTER (WHERE q.status = 'queued') AS next
                        FROM public.jobs q WHERE q."tenantId" = t) a
               WHERE u."tenantId" = t;
              repaired := repaired + 1;
            END IF;
            tried := tried || t;
            t := NULL;
          END LOOP;
          -- Бюджет кандидатів вичерпано: якщо ще хтось готовий, повторити варто одразу.
          RETURN QUERY SELECT NULL::public.jobs, NULL::timestamptz, repaired,
            skipped OR EXISTS (SELECT 1 FROM public.tenant_usage u
                                WHERE u.ready AND u.running < u."maxRunning"
                                  AND u."tenantId" <> ALL (tried))${alsoUnpromoted};
        END $$`;
}

export class FairPromotion1795800000000 implements MigrationInterface {
  name = 'FairPromotion1795800000000';

  async up(runner: QueryRunner): Promise<void> {
    // CREATE OR REPLACE зберігає власника (системна роль) і права EXECUTE функції.
    await runner.query(fairClaimJobSql());
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      claimJobSql(true).replace(
        'CREATE FUNCTION',
        'CREATE OR REPLACE FUNCTION',
      ),
    );
  }
}
