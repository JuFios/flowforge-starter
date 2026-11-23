import { createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';

/** Найбільша відповідь 202, яку скрипт читає: `{ executionId, executionPurged }` значно менша. */
const MAX_RESPONSE_BYTES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Відповідь 202 означає, що доставку прийнято. Проблема з тілом відповіді прийняття не скасовує, і
 * повідомлення мусить це сказати: повтор тими самими байтами й ID безпечний і поверне той самий
 * executionId.
 */
class AcceptedDeliveryError extends Error {
  constructor(why: string) {
    super(`delivery accepted (HTTP 202), but ${why}`);
  }
}

export interface WebhookDelivery {
  endpoint: string | undefined;
  deliveryId: string | undefined;
  file: string | undefined;
  secret: string | undefined;
}

/** Підписує й надсилає доставку; повертає рядок для друку. */
export async function sendWebhook({
  endpoint,
  deliveryId,
  file,
  secret,
}: WebhookDelivery): Promise<string> {
  if (
    !secret ||
    !endpoint ||
    !file ||
    !deliveryId ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(deliveryId)
  )
    throw new Error(
      'usage: send-webhook URL DELIVERY_ID FILE with WEBHOOK_SECRET set',
    );
  const url = new URL(endpoint),
    match = /^\/hooks\/([\da-f-]{36})$/i.exec(url.pathname);
  if (
    !match ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('invalid endpoint');
  const handle = await open(file, 'r');
  let body: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 1048576)
      throw new Error('expected a regular JSON file up to 1 MiB');
    const bytes = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== info.size) throw new Error('file changed during signing');
    body = bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
  const timestamp = String(Math.floor(Date.now() / 1000));
  const prefix = `v1\n${match[1].toLowerCase()}\n${timestamp}\n${deliveryId}\n`;
  const signature = createHmac('sha256', secret)
    .update(prefix)
    .update(body)
    .digest('hex');
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': timestamp,
      'x-webhook-delivery-id': deliveryId,
      'x-signature': 'v1=' + signature,
    },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(15000),
  });
  // Відповідь інтегратора містить лише статус та ідентифікатор прийнятої доставки.
  if (response.status !== 202) {
    await response.body?.cancel();
    throw new Error('HTTP ' + response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AcceptedDeliveryError('the response is empty');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_RESPONSE_BYTES)
        throw new AcceptedDeliveryError('the response is larger than 4 KiB');
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof AcceptedDeliveryError) throw error;
    throw new AcceptedDeliveryError('reading the response failed');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  let result: unknown;
  try {
    result = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new AcceptedDeliveryError('the response is not JSON');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result))
    throw new AcceptedDeliveryError('the response is not a JSON object');
  const { executionId, executionPurged } = result as {
    executionId?: unknown;
    executionPurged?: unknown;
  };
  if (typeof executionId !== 'string' || !UUID.test(executionId))
    throw new AcceptedDeliveryError('the response has no valid executionId');
  // Прапорця немає у відповідях API до його появи: ID відомий, позначки очищення просто немає.
  if (executionPurged !== undefined && typeof executionPurged !== 'boolean')
    throw new AcceptedDeliveryError('executionPurged is not a boolean');
  // Повтор після очищення історії: доставку прийнято, але виконання за цим ID вже немає.
  return [
    response.status,
    executionId,
    ...(executionPurged === true ? ['(execution history purged)'] : []),
  ].join(' ');
}

if (require.main === module) {
  const [endpoint, deliveryId, file] = process.argv.slice(2);
  sendWebhook({
    endpoint,
    deliveryId,
    file,
    secret: process.env.WEBHOOK_SECRET,
  }).then(
    (line) => console.log(line),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : 'delivery failed');
      process.exitCode = 1;
    },
  );
}
