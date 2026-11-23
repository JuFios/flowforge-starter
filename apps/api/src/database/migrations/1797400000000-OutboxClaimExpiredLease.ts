import { MigrationInterface, QueryRunner } from 'typeorm';
import { CLAIM_OUTBOX_EVENT_V1 } from './1796200000000-NotificationOutbox';

const DEFINER = `SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp`;

/**
 * Перезахоплення події з простроченою орендою, у якої немає відкритої спроби.
 *
 * Перша версія після `UPDATE outbox_attempts … 'lease_expired'` перевіряла `IF NOT FOUND`, а
 * `FOUND` у PL/pgSQL відображає останній оператор, тобто цей `UPDATE`. Якщо відкритої спроби не
 * було (рядок закрито чи відсутній), подія `sending` вважалася відсутньою: функція лише
 * перераховувала підказку, тож подія ніколи не перезахоплювалася й блокувала доставку тенанта.
 * Тепер результат вибору події зберігається окремо одразу після кожного `SELECT`.
 *
 * Той самий клас розходження стану: якщо журнал спроб випереджає лічильник події, номер нової
 * спроби (`attempts + 1`) порушив би первинний ключ журналу й відкотив би весь виклик для всіх
 * тенантів. Номер береться від більшого з лічильника й журналу, а всі відкриті спроби події з
 * простроченою орендою закриваються як `lease_expired`.
 */
const CLAIM_OUTBOX_EVENT_V2 = `CREATE OR REPLACE FUNCTION public.claim_outbox_event(
        p_sender text, p_lease_ms integer, p_in_flight integer)
      RETURNS TABLE (id uuid, "tenantId" uuid, "leaseToken" uuid, attempt integer,
                     "correlationId" varchar, repaired integer)
      LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$
      DECLARE
        s record;
        e record;
        busy integer;
        picked boolean;
        next_attempt integer;
        fixed integer := 0;
        lease interval := make_interval(secs => LEAST(GREATEST(p_lease_ms, 1000), 600000) / 1000.0);
      BEGIN
        FOR s IN
          -- Тенанти, що вже вичерпали ліміт спроб у роботі, у вікно кандидатів не потрапляють:
          -- інакше 16 тенантів із завислими endpoint-ами займали б усе вікно до спливання lease.
          SELECT n."tenantId" FROM public.notification_settings n
           WHERE n.enabled AND n."dueAt" <= now()
             AND (SELECT count(*) FROM public.outbox_events b
                   WHERE b."tenantId" = n."tenantId" AND b.status = 'sending'
                     AND b."leaseUntil" > now()) < GREATEST(p_in_flight, 1)
           ORDER BY n."lastClaimedAt" NULLS FIRST, n."tenantId"
           LIMIT 16
           FOR NO KEY UPDATE SKIP LOCKED
        LOOP
          SELECT count(*) INTO busy FROM public.outbox_events o
           WHERE o."tenantId" = s."tenantId" AND o.status = 'sending' AND o."leaseUntil" > now();
          CONTINUE WHEN busy >= GREATEST(p_in_flight, 1);
          -- Спроба, чий відправник зник (lease минув), — першою: вона найдовше чекає.
          SELECT o.id, o.attempts INTO e FROM public.outbox_events o
           WHERE o."tenantId" = s."tenantId" AND o.status = 'sending' AND o."leaseUntil" <= now()
           ORDER BY o."leaseUntil" LIMIT 1 FOR UPDATE SKIP LOCKED;
          picked := FOUND;
          IF picked THEN
            -- Подію заблоковано, а її токен зміниться нижче: будь-яка відкрита спроба вже не
            -- завершиться відправником, тож закриваються всі, а не лише остання за лічильником.
            UPDATE public.outbox_attempts a SET outcome = 'lease_expired', "finishedAt" = now()
             WHERE a."eventId" = e.id AND a."finishedAt" IS NULL;
          ELSE
            SELECT o.id, o.attempts INTO e FROM public.outbox_events o
             WHERE o."tenantId" = s."tenantId" AND o.status = 'pending' AND o."nextAttemptAt" <= now()
             ORDER BY o."nextAttemptAt" LIMIT 1 FOR UPDATE SKIP LOCKED;
            picked := FOUND;
          END IF;
          IF NOT picked THEN
            -- Підказка застаріла (спробу щойно записали чи подію доставили): перерахувати.
            UPDATE public.notification_settings n SET "dueAt" = LEAST(
                (SELECT min(o."nextAttemptAt") FROM public.outbox_events o
                  WHERE o."tenantId" = s."tenantId" AND o.status = 'pending'),
                (SELECT min(o."leaseUntil") FROM public.outbox_events o
                  WHERE o."tenantId" = s."tenantId" AND o.status = 'sending'))
             WHERE n."tenantId" = s."tenantId";
            fixed := fixed + 1;
            CONTINUE;
          END IF;
          SELECT GREATEST(e.attempts, COALESCE(max(a.attempt), 0)) + 1 INTO next_attempt
            FROM public.outbox_attempts a WHERE a."eventId" = e.id;
          UPDATE public.outbox_events o
             SET status = 'sending', "leaseToken" = gen_random_uuid(),
                 "leaseUntil" = clock_timestamp() + lease, attempts = next_attempt
           WHERE o.id = e.id
           RETURNING o.id, o."tenantId", o."leaseToken", o.attempts, o."correlationId"
            INTO id, "tenantId", "leaseToken", attempt, "correlationId";
          INSERT INTO public.outbox_attempts ("eventId", "tenantId", attempt, "senderId")
          VALUES (id, "tenantId", attempt, left(p_sender, 64));
          UPDATE public.notification_settings n SET "lastClaimedAt" = clock_timestamp()
           WHERE n."tenantId" = s."tenantId";
          repaired := fixed;
          RETURN NEXT;
          RETURN;
        END LOOP;
        id := NULL; "tenantId" := NULL; "leaseToken" := NULL; attempt := NULL;
        "correlationId" := NULL; repaired := fixed;
        RETURN NEXT;
      END $$`;

/** `CREATE OR REPLACE` зберігає власника, `SECURITY DEFINER` і гранти функції. */
export class OutboxClaimExpiredLease1797400000000 implements MigrationInterface {
  name = 'OutboxClaimExpiredLease1797400000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(CLAIM_OUTBOX_EVENT_V2);
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(
      CLAIM_OUTBOX_EVENT_V1.replace(
        /^CREATE FUNCTION /,
        'CREATE OR REPLACE FUNCTION ',
      ),
    );
  }
}
