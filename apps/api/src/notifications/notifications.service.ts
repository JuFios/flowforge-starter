import {
  cursorAtSql,
  decodeKeysetCursor,
  KeysetPosition,
  Page,
  toPage,
} from '../common/keyset-cursor';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { OutboxFullException } from '../limits/limit-exceptions';
import { LimitsMetrics } from '../limits/limits.metrics';
import {
  assertCanRotate,
  keyViews,
  planRevoke,
  SigningKeyView,
} from '../common/signing-keys';
import { randomBytes, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { assertNotificationUrl } from '../engine/outbound-http';
import { StepError } from '../engine/step-error';
import { TenantDb } from '../tenancy/tenant-db';
import {
  EventStatus,
  ListEventsQuery,
  NotificationSettingsDto,
} from './notifications.dto';

export interface SettingsView {
  url: string;
  enabled: boolean;
  /** Росте з кожною зміною адреси чи ввімкненням; кожна спроба записує, з якою ревізією йшла. */
  revision: number;
  keys: SigningKeyView[];
}

interface SettingsRow {
  url: string;
  enabled: boolean;
  revision: number;
  secretKeyId: string;
  nextSecretKeyId: string | null;
}

export interface EventView {
  id: string;
  executionId: string;
  sequence: number;
  type: string;
  status: EventStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  lastStatus: number | null;
  correlationId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

interface AttemptCursor {
  after: number;
  through: number;
}
interface AttemptRow {
  attempt: number;
}
function attemptCursor(id: string, raw: string): AttemptCursor {
  const decoded = Buffer.from(raw, 'base64url').toString('ascii');
  const parts = /^([0-9a-f-]{36})\|([1-9]\d{0,9})\|([1-9]\d{0,9})$/.exec(
    decoded,
  );
  if (
    !parts ||
    parts[1] !== id.toLowerCase() ||
    Buffer.from(decoded).toString('base64url') !== raw
  )
    throw new BadRequestException(['cursor is invalid']);
  const after = Number(parts[2]),
    through = Number(parts[3]);
  if (after >= through || through > 2147483647)
    throw new BadRequestException(['cursor is invalid']);
  return { after, through };
}

/** Розмір порції явної відмови від подій (`discard`). */
const DISCARD_BATCH = 1000;

const EVENT_COLUMNS = `id, "executionId", sequence, type, status, attempts,
  CASE WHEN status = 'pending' THEN "nextAttemptAt" END AS "nextAttemptAt",
  "lastError", "lastStatus", "correlationId", "createdAt", "deliveredAt"`;

/** Секрет підпису: 32 випадкові байти, hex (показується лише раз). */
const newSecret = () => randomBytes(32).toString('hex');

/**
 * Налаштування сповіщень і журнал подій тенанта (README 3.3.9). Усе — у транзакції тенанта (RLS) з
 * явним предикатом `tenantId`. Секрети підпису повертаються лише в момент створення (першого
 * налаштування чи ротації) і більше ніде: не в читанні, не в помилках, не в логах.
 *
 * Порядок блокувань: за потреби рядок тенанта → налаштування → подія → облік.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly db: TenantDb,
    @Optional() private readonly limits?: LimitsMetrics,
  ) {}

  async get(tenantId: string): Promise<SettingsView> {
    return this.db.run(tenantId, async (em) =>
      view(await this.settings(em, tenantId, false)),
    );
  }

  /**
   * Створює або змінює налаштування. URL перевіряється до транзакції (DNS — поза з'єднанням із
   * БД). Перше налаштування повертає ключ підпису разом із секретом — єдиний раз.
   */
  async put(
    tenantId: string,
    input: NotificationSettingsDto,
  ): Promise<SettingsView & { secret?: string }> {
    await this.checkUrl(input.url);
    return this.db.run(tenantId, async (em) => {
      await this.lockSettingsLifecycle(em, tenantId);
      const secret = newSecret();
      const keyId = randomUUID();
      const [row]: SettingsRow[] = await em.query(
        `INSERT INTO notification_settings AS s ("tenantId", url, enabled, "secretKeyId", secret, "dueAt")
         VALUES ($1,$2,COALESCE($3,true),$4,$5,
           -- Події, що чекали без налаштувань, — до відправника з найранішого моменту повтору.
           (SELECT min("nextAttemptAt") FROM outbox_events
             WHERE "tenantId" = $1 AND status = 'pending'))
         ON CONFLICT ("tenantId") DO UPDATE SET
           url=EXCLUDED.url, enabled=COALESCE($3,s.enabled),
           revision=s.revision + (s.url <> EXCLUDED.url OR ($3 IS TRUE AND NOT s.enabled))::integer,
           "dueAt"=CASE WHEN $3 IS TRUE AND NOT s.enabled
             THEN LEAST(s."dueAt", EXCLUDED."dueAt") ELSE s."dueAt" END,
           "updatedAt"=now()
         RETURNING url, enabled, revision, "secretKeyId", "nextSecretKeyId"`,
        [tenantId, input.url, input.enabled ?? null, keyId, secret],
      );
      return row.secretKeyId === keyId ? { ...view(row), secret } : view(row);
    });
  }

  /**
   * Видаляє налаштування: нових подій для тенанта більше немає, а вже прийняті чекають `pending`,
   * доки тенант не налаштує endpoint знову (тоді доставка поновлюється з тими самими ID і байтами).
   * Спроба, що зараз триває, повертається в `pending` і закривається як `paused`: її fencing-токен
   * скинуто, тож пізня відповідь отримувача нічого не змінить. Відмова від подій — лише явна
   * (`discard`).
   */
  async remove(tenantId: string): Promise<void> {
    await this.db.run(tenantId, async (em) => {
      await this.lockSettingsLifecycle(em, tenantId);
      await this.settings(em, tenantId, true);
      // Тригер close_paused_attempt розпізнає паузу за відсутністю налаштувань.
      await em.query(
        'DELETE FROM notification_settings WHERE "tenantId" = $1',
        [tenantId],
      );
      await em.query(
        `UPDATE outbox_events SET status = 'pending', "leaseToken" = NULL, "leaseUntil" = NULL,
                "nextAttemptAt" = now()
          WHERE "tenantId" = $1 AND status = 'sending'`,
        [tenantId],
      );
    });
  }

  /**
   * Явна відмова тенанта від недоставлених подій, створених до цього запиту: `pending` →
   * `cancelled`. Спроби, що зараз тривають, не перериваються. Порціями по окремих транзакціях, щоб
   * великий беклог не тримав блокування й не впирався в statement_timeout. Курсор іде лише вперед:
   * якщо тенант знову поставив оброблену подію на доставку, поточний запит її не скасовує повторно.
   * Блокування читача журналу сумісне з оновленням стану. Після конкурентного запису БД перевіряє
   * стан події повторно, а час очікування обмежує statement_timeout.
   */
  async discard(tenantId: string): Promise<{ discarded: number }> {
    // Межа «до цього запиту» — за годинником БД і з його точністю до мікросекунд.
    const [{ cutoff }] = await this.db.run(tenantId, (em) =>
      em.query<Array<{ cutoff: string }>>(
        `SELECT ${cursorAtSql('now()')} AS cutoff`,
      ),
    );
    let discarded = 0;
    let after: KeysetPosition | undefined;
    for (;;) {
      const [batch] = await this.db.run(tenantId, (em) =>
        em.query<Array<KeysetPosition & { count: number }>>(
          `WITH batch AS (
             SELECT id FROM outbox_events
              WHERE "tenantId" = $1 AND status = 'pending' AND "createdAt" <= $2
                AND ("createdAt", id) > (
                  COALESCE($3::timestamptz, '-infinity'::timestamptz),
                  COALESCE($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
                )
              ORDER BY "createdAt", id LIMIT $5 FOR NO KEY UPDATE
           ), updated AS (
             UPDATE outbox_events e SET status = 'cancelled', "cancelledAt" = now()
              FROM batch b WHERE e."tenantId" = $1 AND e.id = b.id
             RETURNING e."createdAt", e.id
           )
           SELECT id, ${cursorAtSql('"createdAt"')} AS "createdAt",
                  (count(*) OVER ())::int AS count
             FROM updated ORDER BY updated."createdAt" DESC, id DESC LIMIT 1`,
          [
            tenantId,
            cutoff,
            after?.createdAt ?? null,
            after?.id ?? null,
            DISCARD_BATCH,
          ],
        ),
      );
      if (!batch) return { discarded };
      discarded += batch.count;
      if (batch.count < DISCARD_BATCH) return { discarded };
      after = batch;
    }
  }

  /** Ротація: новий ключ `next` (секрет — лише в цій відповіді); підписи — обома, доки не відкличуть. */
  async rotate(tenantId: string): Promise<{ id: string; secret: string }> {
    return this.db.run(tenantId, async (em) => {
      assertCanRotate(pair(await this.settings(em, tenantId, true)));
      const id = randomUUID(),
        secret = newSecret();
      await em.query(
        `UPDATE notification_settings SET "nextSecretKeyId" = $2, "nextSecret" = $3, "updatedAt" = now()
          WHERE "tenantId" = $1`,
        [tenantId, id, secret],
      );
      return { id, secret };
    });
  }

  /** Відкликання ключа; повтор для вже відсутнього нічого не змінює. Останній ключ не відкликається. */
  async revoke(tenantId: string, rawId: string): Promise<void> {
    const id = rawId.toLowerCase();
    await this.db.run(tenantId, async (em) => {
      const plan = planRevoke(
        pair(await this.settings(em, tenantId, true)),
        id,
      );
      if (plan === 'promote') {
        await em.query(
          `UPDATE notification_settings
              SET "secretKeyId" = "nextSecretKeyId", secret = "nextSecret",
                  "nextSecretKeyId" = NULL, "nextSecret" = NULL, "updatedAt" = now()
            WHERE "tenantId" = $1`,
          [tenantId],
        );
      } else if (plan === 'drop-next') {
        await em.query(
          `UPDATE notification_settings SET "nextSecretKeyId" = NULL, "nextSecret" = NULL,
                  "updatedAt" = now()
            WHERE "tenantId" = $1`,
          [tenantId],
        );
      }
    });
  }

  async listEvents(
    tenantId: string,
    query: ListEventsQuery,
  ): Promise<Page<EventView>> {
    const limit = query.limit ?? 50;
    const after = query.cursor ? decodeKeysetCursor(query.cursor) : null;
    const params: unknown[] = [tenantId, limit + 1];
    const where = ['"tenantId" = $1'];
    if (query.status) {
      params.push(query.status);
      where.push(`status = $${params.length}`);
    }
    if (after) {
      params.push(after.createdAt, after.id);
      where.push(
        `("createdAt", id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    const rows: Array<EventView & { cursorAt: string }> = await this.db.run(
      tenantId,
      (em) =>
        em.query(
          `SELECT ${EVENT_COLUMNS}, ${cursorAtSql('"createdAt"')} AS "cursorAt"
             FROM outbox_events WHERE ${where.join(' AND ')}
            ORDER BY "createdAt" DESC, id DESC LIMIT $2`,
          params,
        ),
    );
    return toPage(rows, limit);
  }

  /** Верхня межа фіксує набір номерів спроб на початку обходу. */
  async eventPage(
    tenantId: string,
    id: string,
    limit: number,
    rawCursor?: string,
  ) {
    return this.db.run(tenantId, async (em) => {
      const [event]: Array<EventView & { payload: string }> = await em.query(
        `SELECT ${EVENT_COLUMNS}, payload FROM outbox_events WHERE id = $1 AND "tenantId" = $2 FOR KEY SHARE`,
        [id, tenantId],
      );
      if (!event) throw new NotFoundException('Подію не знайдено');
      const { after, through } = rawCursor
        ? attemptCursor(id, rawCursor)
        : { after: 0, through: event.attempts };
      if (through > event.attempts)
        throw new BadRequestException(['cursor is invalid']);
      const rows: AttemptRow[] = await em.query(
        `SELECT attempt, "senderId", revision, "keyIds", "startedAt", "finishedAt", outcome, "httpStatus", "durationMs"
           FROM outbox_attempts WHERE "eventId"=$1 AND "tenantId"=$2 AND attempt>$3 AND attempt<=$4
           ORDER BY attempt LIMIT $5`,
        [id, tenantId, after, through, limit + 1],
      );
      const attempts = rows.slice(0, limit);
      const nextAttemptsCursor =
        rows.length > limit
          ? Buffer.from(
              `${event.id}|${attempts[limit - 1].attempt}|${through}`,
            ).toString('base64url')
          : null;
      return { ...event, attempts, nextAttemptsCursor };
    });
  }

  /**
   * Надіслати подію ще раз негайно (той самий ID і байти): для недоставленої — без очікування
   * backoff, для доставленої чи скасованої — повторна доставка в межах квоти outbox. Спроба, що
   * триває, — 409. Без налаштувань подія чекає `pending` і піде, щойно тенант налаштує endpoint.
   */
  async redeliver(tenantId: string, id: string): Promise<EventView> {
    return this.db.run(tenantId, async (em) => {
      await this.lockSettingsLifecycle(em, tenantId);
      await em.query(
        'SELECT 1 FROM notification_settings WHERE "tenantId" = $1 FOR NO KEY UPDATE',
        [tenantId],
      );
      const [event]: Array<{ status: EventStatus }> = await em.query(
        'SELECT status FROM outbox_events WHERE id = $1 AND "tenantId" = $2 FOR UPDATE',
        [id, tenantId],
      );
      if (!event) throw new NotFoundException('Подію не знайдено');
      if (event.status === 'sending')
        throw new ConflictException('Спроба доставки цієї події вже триває');
      if (event.status !== 'pending') await this.assertOutboxSlot(em);
      const [[updated]]: [EventView[], number] = await em.query(
        `UPDATE outbox_events SET status = 'pending', "nextAttemptAt" = now(), "deliveredAt" = NULL,
                "cancelledAt" = NULL
          WHERE id = $1 AND "tenantId" = $2 RETURNING ${EVENT_COLUMNS}`,
        [id, tenantId],
      );
      await em.query(
        `UPDATE notification_settings SET "dueAt" = now()
          WHERE "tenantId" = $1 AND ("dueAt" IS NULL OR "dueAt" > now())`,
        [tenantId],
      );
      return updated;
    });
  }

  /** Серіалізує читання підказки доставки з відновленням подій навіть без рядка налаштувань. */
  private async lockSettingsLifecycle(
    em: EntityManager,
    tenantId: string,
  ): Promise<void> {
    await em.query('SELECT id FROM tenants WHERE id=$1 FOR NO KEY UPDATE', [
      tenantId,
    ]);
  }

  /**
   * Доставлена чи скасована подія знову стає недоставленою: квота outbox перевіряється так само, як
   * для нового виконання, під блокуванням рядка обліку тенанта після блокування події.
   */
  private async assertOutboxSlot(em: EntityManager): Promise<void> {
    const [usage]: Array<{
      queued: number;
      running: number;
      outboxUndelivered: number;
      maxOutboxEvents: number;
    }> = await em.query(
      'SELECT queued, running, "outboxUndelivered", "maxOutboxEvents" FROM lock_tenant_usage()',
    );
    if (
      usage.outboxUndelivered + usage.queued + usage.running <
      usage.maxOutboxEvents
    )
      return;
    this.limits?.enqueueRejected.inc({
      reason: 'outbox_full',
      trigger: 'redeliver',
    });
    throw new OutboxFullException(usage.maxOutboxEvents);
  }

  private async settings(
    em: EntityManager,
    tenantId: string,
    lock: boolean,
  ): Promise<SettingsRow> {
    const [row]: SettingsRow[] = await em.query(
      `SELECT url, enabled, revision, "secretKeyId", "nextSecretKeyId"
         FROM notification_settings WHERE "tenantId" = $1${lock ? ' FOR NO KEY UPDATE' : ''}`,
      [tenantId],
    );
    if (!row) throw new NotFoundException('Сповіщення не налаштовано');
    return row;
  }

  private async checkUrl(url: string): Promise<void> {
    try {
      await assertNotificationUrl(url);
    } catch (err) {
      // Причину відмови тенант знає з контракту; внутрішні деталі (адреси DNS) не розкриваються.
      if (err instanceof StepError)
        throw new BadRequestException([
          'url must be an https URL of a public host without credentials',
        ]);
      throw new BadRequestException(['url host could not be resolved']);
    }
  }
}

function pair(row: SettingsRow) {
  return { current: row.secretKeyId, next: row.nextSecretKeyId };
}

function view(row: SettingsRow): SettingsView {
  return {
    url: row.url,
    enabled: row.enabled,
    revision: row.revision,
    keys: keyViews(pair(row)),
  };
}
