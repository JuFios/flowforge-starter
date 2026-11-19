import { createHmac, randomUUID } from 'node:crypto';

/** Незалежний підпис відправника над точними байтами для HTTP-тестів. */
export function signedHeaders(
  workflowId: string,
  secret: string,
  body: string,
  deliveryId: string = randomUUID(),
  timestamp = Math.floor(Date.now() / 1000),
) {
  const mac = createHmac('sha256', secret)
    .update(`v1\n${workflowId.toLowerCase()}\n${timestamp}\n${deliveryId}\n`)
    .update(body)
    .digest('hex');
  return {
    'x-signature': 'v1=' + mac,
    'x-webhook-delivery-id': deliveryId,
    'x-webhook-timestamp': String(timestamp),
  };
}
