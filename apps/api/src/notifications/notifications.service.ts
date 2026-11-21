import {
  cursorAtSql,
  decodeKeysetCursor,
  Page,
  toPage,
} from '../common/keyset-cursor';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  keyViews,
  planRevoke,
  planRotate,
  RotationResult,
  SigningKeyView,
} from '../common/signing-keys';
import { safeEqual } from '../common/safe-equal';
import { randomUUID } from 'node:crypto';
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

const EVENT_COLUMNS = `id, "executionId", sequence, type, status, attempts,
  CASE WHEN status = 'pending' THEN "nextAttemptAt" END AS "nextAttemptAt",
  "lastError", "lastStatus", "correlationId", "createdAt", "deliveredAt"`;

/**
 * Налаштування сповіщень і журнал подій тенанта (README 3.3.9). Усе — у транзакції тенанта (RLS) з
 * явним предикатом `tenantId`. Секрети підпису генерує тенант і передає в тілі першого налаштування
 * чи ротації; сервер їх не повертає ніде: ні у відповідях, ні в помилках, ні в логах (ТЗ 4).
 *
 * Порядок блокувань: рядок налаштувань → події (так само, як у захопленні спроби).
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly db: TenantDb) {}

  async get(tenantId: string): Promise<SettingsView> {
    return this.db.run(tenantId, async (em) =>
      view(await this.settings(em, tenantId, false)),
    );
  }

  /**
   * Створює або змінює налаштування. URL перевіряється до транзакції (DNS — поза з'єднанням із
   * БД). Перше налаштування вимагає секрет підпису від тенанта; повтор із тим самим секретом —
   * звичайне оновлення (втрачена відповідь), інший секрет — 409 (новий ключ — лише ротацією).
   */
  async put(
    tenantId: string,
    input: NotificationSettingsDto,
  ): Promise<SettingsView> {
    await this.checkUrl(input.url);
    return this.db.run(tenantId, async (em) => {
      let current = await this.currentSecret(em, tenantId);
      if (current === undefined) {
        if (input.secret === undefined)
          throw new BadRequestException([
            'secret is required to create notification settings',
          ]);
        const [inserted]: SettingsRow[] = await em.query(
          `INSERT INTO notification_settings ("tenantId", url, enabled, "secretKeyId", secret)
           VALUES ($1,$2,COALESCE($3,true),$4,$5)
           ON CONFLICT ("tenantId") DO NOTHING
           RETURNING url, enabled, revision, "secretKeyId", "nextSecretKeyId"`,
          [
            tenantId,
            input.url,
            input.enabled ?? null,
            randomUUID(),
            input.secret,
          ],
        );
        if (inserted) return view(inserted);
        // Паралельне перше налаштування встигло першим: далі — як оновлення його рядка.
        current = await this.currentSecret(em, tenantId);
        if (current === undefined)
          throw new ConflictException('Налаштування щойно видалено');
      }
      if (input.secret !== undefined && !safeEqual(input.secret, current))
        throw new ConflictException(
          'Секрет уже налаштовано; новий ключ додає ротація',
        );
      // UPDATE … RETURNING у TypeORM повертає пару [рядки, кількість].
      const [[row]]: [SettingsRow[], number] = await em.query(
        `UPDATE notification_settings AS s SET
           url = $2, enabled = COALESCE($3, s.enabled),
           revision = s.revision + (s.url <> $2 OR ($3 IS TRUE AND NOT s.enabled))::integer,
           "updatedAt" = now()
         WHERE "tenantId" = $1
         RETURNING url, enabled, revision, "secretKeyId", "nextSecretKeyId"`,
        [tenantId, input.url, input.enabled ?? null],
      );
      return view(row);
    });
  }

  /** Чинний секрет під блокуванням рядка налаштувань або undefined, якщо їх немає. */
  private async currentSecret(
    em: EntityManager,
    tenantId: string,
  ): Promise<string | undefined> {
    const [row]: Array<{ secret: string }> = await em.query(
      'SELECT secret FROM notification_settings WHERE "tenantId" = $1 FOR NO KEY UPDATE',
      [tenantId],
    );
    return row?.secret;
  }

  /**
   * Видаляє налаштування; недоставлені події стають `cancelled` (лишаються в журналі). Спроба, що
   * зараз триває, після цього нічого не змінить: її fencing-токен скинуто.
   */
  async remove(tenantId: string): Promise<void> {
    await this.db.run(tenantId, async (em) => {
      await this.settings(em, tenantId, true);
      await em.query(
        `UPDATE outbox_events SET status = 'cancelled', "leaseToken" = NULL, "leaseUntil" = NULL
          WHERE "tenantId" = $1 AND status IN ('pending', 'sending')`,
        [tenantId],
      );
      await em.query(
        'DELETE FROM notification_settings WHERE "tenantId" = $1',
        [tenantId],
      );
    });
  }

  /**
   * Ротація: новий ключ `next` із секретом тенанта; підписи — обома, доки не відкличуть. Повтор із
   * тим самим секретом повертає той самий ID (`created: false`).
   */
  async rotate(tenantId: string, secret: string): Promise<RotationResult> {
    return this.db.run(tenantId, async (em) => {
      const [row]: Array<{
        secretKeyId: string;
        secret: string;
        nextSecretKeyId: string | null;
        nextSecret: string | null;
      }> = await em.query(
        `SELECT "secretKeyId", secret, "nextSecretKeyId", "nextSecret"
           FROM notification_settings WHERE "tenantId" = $1 FOR NO KEY UPDATE`,
        [tenantId],
      );
      if (!row) throw new NotFoundException('Сповіщення не налаштовано');
      const plan = planRotate(
        { id: row.secretKeyId, secret: row.secret },
        row.nextSecretKeyId && row.nextSecret
          ? { id: row.nextSecretKeyId, secret: row.nextSecret }
          : null,
        secret,
      );
      if (plan.created)
        await em.query(
          `UPDATE notification_settings SET "nextSecretKeyId" = $2, "nextSecret" = $3, "updatedAt" = now()
            WHERE "tenantId" = $1`,
          [tenantId, plan.id, secret],
        );
      return plan;
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
   * backoff, для доставленої чи скасованої — повторна доставка. Спроба, що триває, — 409.
   */
  async redeliver(tenantId: string, id: string): Promise<EventView> {
    return this.db.run(tenantId, async (em) => {
      await this.settings(em, tenantId, true);
      const [event]: Array<{ status: EventStatus }> = await em.query(
        'SELECT status FROM outbox_events WHERE id = $1 AND "tenantId" = $2 FOR UPDATE',
        [id, tenantId],
      );
      if (!event) throw new NotFoundException('Подію не знайдено');
      if (event.status === 'sending')
        throw new ConflictException('Спроба доставки цієї події вже триває');
      const [[updated]]: [EventView[], number] = await em.query(
        `UPDATE outbox_events SET status = 'pending', "nextAttemptAt" = now(), "deliveredAt" = NULL
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
