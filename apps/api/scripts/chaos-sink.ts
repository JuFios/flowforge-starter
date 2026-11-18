/**
 * Отримувач http-кроків для chaos-сценарію (сервіс `sink` у docker-compose.chaos.yml).
 * Поводиться як сумлінний зовнішній сервіс: ефект («списання») виконує один раз на
 * Idempotency-Key, повторний запит з тим самим ключем отримує той самий результат.
 * Відповідає із затримкою, щоб вбивство воркера частіше заставало крок посередині.
 *
 *   POST /effect  — виконати ефект (заголовок Idempotency-Key обов'язковий)
 *   GET  /stats   — { requests, effects, repeatedKeys, missingKey }
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.SINK_PORT ?? 8080);
const DELAY_MS = Number(process.env.SINK_DELAY_MS ?? 300);

const effects = new Map<string, number>(); // ключ → скільки разів запит із ним приходив
let requests = 0;
let missingKey = 0;

createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0];
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
  if (req.method === 'POST' && path === '/effect') {
    req.resume();
    req.on('end', () => {
      requests++;
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || key === '') {
        missingKey++;
        res.writeHead(400).end();
        return;
      }
      effects.set(key, (effects.get(key) ?? 0) + 1);
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ key }));
      }, DELAY_MS);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`chaos sink on ${PORT}`));
