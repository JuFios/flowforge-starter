import { createHmac } from 'node:crypto';
import { open } from 'node:fs/promises';

async function main(): Promise<void> {
  const [endpoint, deliveryId, file] = process.argv.slice(2);
  const secret = process.env.WEBHOOK_SECRET;
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
  if (!reader) throw new Error('empty response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) throw new Error('invalid response size');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as {
    executionId?: unknown;
    executionPurged?: unknown;
  };
  if (
    typeof result.executionId !== 'string' ||
    !/^[\da-f-]{36}$/i.test(result.executionId) ||
    typeof result.executionPurged !== 'boolean'
  )
    throw new Error('invalid execution ID');
  // Повтор після очищення історії: доставку прийнято, але виконання за цим ID вже немає.
  console.log(
    response.status,
    result.executionId,
    ...(result.executionPurged ? ['(execution history purged)'] : []),
  );
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'delivery failed');
  process.exitCode = 1;
});
