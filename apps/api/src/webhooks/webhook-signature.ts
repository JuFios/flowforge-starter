import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { EntityManager } from 'typeorm';

export const WEBHOOK_WINDOW_SECONDS = 300;
export interface KeyRow {
  webhookKeyId: string;
  webhookSecret: string;
  nextWebhookKeyId: string | null;
  nextWebhookSecret: string | null;
}
export interface VerifiedDelivery {
  keyId: string;
  deliveryId: string;
  timestamp: number;
  digest: Buffer;
}

export const readClock = async (em: EntityManager): Promise<number> => {
  const [row]: { seconds: number }[] = await em.query(
    'SELECT floor(extract(epoch FROM clock_timestamp()))::float8 AS seconds',
  );
  return row.seconds;
};

function oneHeader(req: Request, name: string): string | undefined {
  const values = req.headersDistinct[name];
  return values?.length === 1 ? values[0] : undefined;
}

export function verifyDelivery(
  req: Request,
  workflowId: string,
  bytes: Buffer,
  keys: KeyRow,
  now: number,
): VerifiedDelivery | undefined {
  const id = oneHeader(req, 'x-webhook-delivery-id');
  const time = oneHeader(req, 'x-webhook-timestamp');
  const signature = oneHeader(req, 'x-signature');
  if (
    !id ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(id) ||
    !time ||
    !/^(0|[1-9][0-9]{0,11})$/.test(time) ||
    !signature ||
    !/^v1=[a-f0-9]{64}$/.test(signature) ||
    Math.abs(Number(time) - now) > WEBHOOK_WINDOW_SECONDS
  )
    return;
  const prefix = `v1\n${workflowId.toLowerCase()}\n${time}\n${id}\n`;
  const mac = Buffer.from(signature.slice(3), 'hex');
  const matches = (secret: string) =>
    timingSafeEqual(
      mac,
      createHmac('sha256', secret).update(prefix).update(bytes).digest(),
    );
  const primary = matches(keys.webhookSecret);
  const secondary = matches(keys.nextWebhookSecret ?? keys.webhookSecret);
  const keyId = primary
    ? keys.webhookKeyId
    : secondary
      ? keys.nextWebhookKeyId
      : null;
  if (keyId)
    return {
      deliveryId: id,
      timestamp: Number(time),
      keyId,
      digest: createHash('sha256').update(bytes).digest(),
    };
}
