import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TenantDb } from '../tenancy/tenant-db';

/**
 * Ключ підпису webhook-ів тенанта (README 3.3.7, «Ротація без простою»). `current` — ключ, що діяв
 * до останньої ротації; `next` — ключ, створений нею. Обидва приймаються, доки `current` не відкличуть.
 */
export interface WebhookKeyView {
  id: string;
  role: 'current' | 'next';
}

interface KeyIds {
  webhookKeyId: string;
  nextWebhookKeyId: string | null;
}

@Injectable()
export class WebhookKeysService {
  constructor(private readonly db: TenantDb) {}

  list(tenantId: string): Promise<WebhookKeyView[]> {
    return this.db.run(tenantId, async (em) =>
      toViews(await keyIds(em, tenantId, false)),
    );
  }

  rotate(tenantId: string): Promise<{ id: string; secret: string }> {
    return this.db.run(tenantId, (em) => this.rotateIn(em, tenantId));
  }

  revoke(tenantId: string, keyId: string): Promise<void> {
    return this.db.run(tenantId, (em) => this.revokeIn(em, tenantId, keyId));
  }

  /** Ротація в транзакції тенанта, яку відкрив викликач. */
  async rotateIn(
    em: EntityManager,
    tenantId: string,
  ): Promise<{ id: string; secret: string }> {
    const keys = await keyIds(em, tenantId, true);
    if (keys.nextWebhookKeyId)
      throw new ConflictException('Уже є два активні ключі');
    const id = randomUUID(),
      secret = randomBytes(24).toString('hex');
    await em.query(
      'UPDATE tenants SET "nextWebhookKeyId"=$2,"nextWebhookSecret"=$3 WHERE id=$1',
      [tenantId, id, secret],
    );
    return { id, secret };
  }

  /** Відкликання; повтор для вже відсутнього ключа нічого не змінює. */
  async revokeIn(
    em: EntityManager,
    tenantId: string,
    rawId: string,
  ): Promise<void> {
    const id = rawId.toLowerCase();
    const keys = await keyIds(em, tenantId, true);
    if (keys.webhookKeyId === id) {
      if (!keys.nextWebhookKeyId)
        throw new ConflictException('Потрібен хоча б один активний ключ');
      await em.query(
        'UPDATE tenants SET "webhookKeyId"="nextWebhookKeyId","webhookSecret"="nextWebhookSecret","nextWebhookKeyId"=NULL,"nextWebhookSecret"=NULL WHERE id=$1',
        [tenantId],
      );
    } else if (keys.nextWebhookKeyId === id) {
      await em.query(
        'UPDATE tenants SET "nextWebhookKeyId"=NULL,"nextWebhookSecret"=NULL WHERE id=$1',
        [tenantId],
      );
    }
  }
}

/**
 * Ідентифікатори ключів тенанта. Зміна набору ключів бере FOR NO KEY UPDATE: вона конфліктує з
 * FOR SHARE постановки webhook-а (повторна перевірка ключа), але не з FOR KEY SHARE зовнішніх
 * ключів, тож вставки виконань і задач тенанта не чекають на керування ключами.
 */
async function keyIds(
  em: EntityManager,
  tenantId: string,
  lock: boolean,
): Promise<KeyIds> {
  const [row]: KeyIds[] = await em.query(
    'SELECT "webhookKeyId","nextWebhookKeyId" FROM tenants WHERE id=$1' +
      (lock ? ' FOR NO KEY UPDATE' : ''),
    [tenantId],
  );
  return row;
}

function toViews(keys: KeyIds): WebhookKeyView[] {
  const views: WebhookKeyView[] = [{ id: keys.webhookKeyId, role: 'current' }];
  if (keys.nextWebhookKeyId)
    views.push({ id: keys.nextWebhookKeyId, role: 'next' });
  return views;
}
