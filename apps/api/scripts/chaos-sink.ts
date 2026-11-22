/**
 * Отримувач http-кроків для chaos-сценарію (сервіс `sink` у docker-compose.chaos.yml).
 * Поводиться як сумлінний зовнішній сервіс: ефект («списання») виконує один раз на
 * Idempotency-Key, повторний запит з тим самим ключем отримує той самий результат.
 * Відповідає із затримкою, щоб вбивство воркера частіше заставало крок посередині.
 *
 *   POST /effect  — виконати ефект (заголовок Idempotency-Key обов'язковий)
 *   GET  /stats   — { requests, effects, repeatedKeys, missingKey }
 *   POST /notifications — прийняти сповіщення FlowForge; перша доставка кожної події «губить»
 *                    підтвердження (з'єднання обривається після прийому тіла)
 *   GET  /notifications — усі прийняті доставки: заголовки й сирі байти тіла (base64)
 *   POST /unavailable — 503 для вимірювання роботи черги під час відмови доставки
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.SINK_PORT ?? 8080);
const DELAY_MS = Number(process.env.SINK_DELAY_MS ?? 300);
const EFFECT_GATE_MS = 12_000;
const EFFECT_GATE_LIMIT = 16;
const EFFECT_GATE = /^\/[a-z-]+\/([0-9a-f-]{36})$/;

const effects = new Map<string, number>(); // ключ → скільки разів запит із ним приходив
let requests = 0;
let missingKey = 0;
const effectGates = new Map<string, () => void>();

interface Delivery {
  id: string;
  attempt: string;
  timestamp: string;
  signature: string;
  requestId: string;
  body: string;
}
/** Не більше стількох записів: сценарій короткий, а пам'ять отримувача — обмежена. */
const MAX_DELIVERIES = 10_000;
const deliveries: Delivery[] = [];
const seen = new Set<string>();
const header = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : '';

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
  const effectGate = EFFECT_GATE.exec(path)?.[1];
  if (
    req.method === 'POST' &&
    path.startsWith('/release-effect/') &&
    effectGate
  ) {
    req.resume();
    const release = effectGates.get(effectGate);
    if (!release) {
      res.writeHead(409).end();
      return;
    }
    release();
    res.writeHead(204).end();
    return;
  }
  if (req.method === 'POST' && path === '/unavailable') {
    req.resume();
    req.on('end', () => res.writeHead(503).end());
    return;
  }
  if (req.method === 'GET' && path === '/header-digest') {
    const value = header(req.headers['x-test-marker']);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        digest: createHash('sha256').update(value).digest('hex'),
      }),
    );
    return;
  }
  if (req.method === 'GET' && path === '/counts') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(effects)));
    return;
  }
  if (req.method === 'GET' && path === '/stats') {
    const repeatedKeys = [...effects.values()].filter((n) => n > 1).length;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        requests,
        effects: effects.size,
        repeatedKeys,
        missingKey,
      }),
    );
    return;
  }
  if (req.method === 'GET' && path === '/notifications') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(deliveries));
    return;
  }
  if (req.method === 'POST' && path === '/notifications') {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= 65_536) chunks.push(c);
    });
    req.on('end', () => {
      const id = header(req.headers['x-flowforge-event-id']);
      if (deliveries.length < MAX_DELIVERIES)
        deliveries.push({
          id,
          attempt: header(req.headers['x-flowforge-attempt']),
          timestamp: header(req.headers['x-flowforge-timestamp']),
          signature: header(req.headers['x-flowforge-signature']),
          requestId: header(req.headers['x-request-id']),
          body: Buffer.concat(chunks).toString('base64'),
        });
      if (!seen.has(id)) {
        seen.add(id);
        // Залишаємо відкриту спробу доступною для бар’єра рестарту PostgreSQL.
        setTimeout(() => req.socket.destroy(), DELAY_MS);
        return;
      }
      res.writeHead(204).end();
    });
    return;
  }
  if (
    req.method === 'POST' &&
    (path === '/effect' || (path.startsWith('/effect/') && effectGate))
  ) {
    req.resume();
    req.on('end', () => {
      requests++;
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key === '') {
        missingKey++;
        res.writeHead(400).end();
        return;
      }
      const previous = effects.get(key) ?? 0;
      effects.set(key, previous + 1);
      const respond = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key }));
      };
      if (!effectGate || previous > 0) {
        setTimeout(respond, DELAY_MS);
        return;
      }
      if (
        effectGates.has(effectGate) ||
        effectGates.size >= EFFECT_GATE_LIMIT
      ) {
        res.writeHead(503).end();
        return;
      }
      const cleanup = () => {
        clearTimeout(timer);
        effectGates.delete(effectGate);
        res.off('close', cleanup);
      };
      const timer = setTimeout(() => {
        cleanup();
        res.writeHead(503).end();
      }, EFFECT_GATE_MS);
      res.once('close', cleanup);
      effectGates.set(effectGate, () => {
        cleanup();
        respond();
      });
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`chaos sink on ${PORT}`));
