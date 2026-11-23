import type { Request } from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendWebhook } from '../../scripts/send-webhook';
import { verifyDelivery } from '../../src/webhooks/webhook-signature';

/**
 * Скрипт відправника з docs/architecture.md (3.3.7) проти локального отримувача: підпис, який
 * приймає API, і повідомлення про відповідь. Після 202 доставку прийнято, тож помилка розбору
 * тіла має казати саме це, а не «невалідний ID».
 */
const WORKFLOW_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const EXECUTION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SECRET = 'a'.repeat(64);
const BODY = '{ "name": "Ada" }\n';

describe('send-webhook script', () => {
  let server: Server;
  let endpoint: string;
  let dir: string;
  let file: string;
  let reply: { status: number; body: string };
  let verified: boolean[];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'send-webhook-'));
    file = join(dir, 'event.json');
    await writeFile(file, BODY);
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        verified.push(
          verifyDelivery(
            req as unknown as Request,
            WORKFLOW_ID,
            Buffer.concat(chunks),
            {
              webhookKeyId: 'key',
              webhookSecret: SECRET,
              nextWebhookKeyId: null,
              nextWebhookSecret: null,
            },
            Math.floor(Date.now() / 1000),
          ) !== undefined,
        );
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    endpoint = `http://127.0.0.1:${port}/hooks/${WORKFLOW_ID}`;
  });

  beforeEach(() => {
    verified = [];
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  function send(status: number, body: string): Promise<string> {
    reply = { status, body };
    return sendWebhook({
      endpoint,
      deliveryId: 'order-42',
      file,
      secret: SECRET,
    });
  }

  it.each([
    [
      { executionId: EXECUTION_ID, executionPurged: false },
      `202 ${EXECUTION_ID}`,
    ],
    [
      { executionId: EXECUTION_ID, executionPurged: true },
      `202 ${EXECUTION_ID} (execution history purged)`,
    ],
    // API до прапорця очищення: доставку прийнято, ID відомий.
    [{ executionId: EXECUTION_ID }, `202 ${EXECUTION_ID}`],
  ])('prints the accepted delivery %j', async (body, line) => {
    await expect(send(202, JSON.stringify(body))).resolves.toBe(line);
    expect(verified).toEqual([true]);
  });

  it.each([
    [
      'a non-boolean purge flag',
      JSON.stringify({ executionId: EXECUTION_ID, executionPurged: 'yes' }),
      'executionPurged is not a boolean',
    ],
    [
      'a malformed ID',
      JSON.stringify({ executionId: 'not-an-id', executionPurged: false }),
      'the response has no valid executionId',
    ],
    [
      'a dash-only ID',
      JSON.stringify({ executionId: '-'.repeat(36), executionPurged: false }),
      'the response has no valid executionId',
    ],
    [
      'a missing ID',
      JSON.stringify({ executionPurged: false }),
      'the response has no valid executionId',
    ],
    ['JSON null', 'null', 'the response is not a JSON object'],
    ['a JSON array', '[]', 'the response is not a JSON object'],
    ['HTML', '<html>', 'the response is not JSON'],
    ['an empty body', '', 'the response is not JSON'],
    [
      'a body over 4 KiB',
      JSON.stringify({ executionId: EXECUTION_ID, pad: 'x'.repeat(4096) }),
      'the response is larger than 4 KiB',
    ],
  ])(
    'reports a 202 with %s as accepted with an unreadable answer',
    async (_label, body, why) => {
      await expect(send(202, body)).rejects.toThrow(
        `delivery accepted (HTTP 202), but ${why}`,
      );
      expect(verified).toEqual([true]);
    },
  );

  it('reports a rejected delivery by its status', async () => {
    await expect(send(409, '{"message":"conflict"}')).rejects.toThrow(
      'HTTP 409',
    );
  });
});
