import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import {
  assertCanRotate,
  keyViews,
  planRevoke,
  SigningKeyView,
} from '../common/signing-keys';
import { TenantDb } from '../tenancy/tenant-db';

/**
 * Ключ підпису webhook-ів тенанта (README 3.3.7, «Ротація без простою»). `current` — ключ, що діяв
 * до останньої ротації; `next` — ключ, створений нею. Обидва приймаються, доки `current` не відкличуть.
 */
export type WebhookKeyView = SigningKeyView;

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
    assertCanRotate(pair(await keyIds(em, tenantId, true)));
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
    const plan = planRevoke(pair(await keyIds(em, tenantId, true)), id);
    if (plan === 'promote') {
      await em.query(
        'UPDATE tenants SET "webhookKeyId"="nextWebhookKeyId","webhookSecret"="nextWebhookSecret","nextWebhookKeyId"=NULL,"nextWebhookSecret"=NULL WHERE id=$1',
        [tenantId],
      );
    } else if (plan === 'drop-next') {
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

function pair(keys: KeyIds) {
  return { current: keys.webhookKeyId, next: keys.nextWebhookKeyId };
}

function toViews(keys: KeyIds): WebhookKeyView[] {
  return keyViews(pair(keys));
}
