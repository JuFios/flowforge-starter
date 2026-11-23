import { fork } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { OUTBOX_ATTEMPT_HISTORY } from '../../src/tenancy/limits';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';

describe('delivery history HTTP response size and API memory', () => {
  let ds: DataSource;
  beforeAll(async () => {
    ds = await openTestDataSource();
  });
  afterAll(async () => {
    await truncateAll(ds);
    await ds.destroy();
  });
  it.each([100, 10_000, 100_000])(
    'measures retained history after %i attempts in a separate API process',
    async (count) => {
      await truncateAll(ds);
      const { tenant, apiKey } = await createTenant(ds);
      const [{ id }] = await ds.query<Array<{ id: string }>>(
        `INSERT INTO outbox_events ("tenantId","executionId",sequence,type,payload)
      VALUES ($1,gen_random_uuid(),1,'execution.succeeded','{}') RETURNING id`,
        [tenant.id],
      );
      for (const query of ['', '?limit=50']) {
        const child = fork(
          join(__dirname, '../helpers/history-benchmark-api.cjs'),
          [],
          {
            env: { ...process.env },
            execArgv: ['--expose-gc'],
            stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
          },
        );
        const message = () =>
          once(child, 'message', { signal: AbortSignal.timeout(30000) });
        const exited = once(child, 'exit');
        try {
          const [{ port }] = (await message()) as [{ port: number }];
          const url = `http://127.0.0.1:${port}/tenants/me/notifications/events/${id}${query}`;
          const read = async () => {
            const res = await fetch(url, {
              headers: { 'x-api-key': apiKey },
              signal: AbortSignal.timeout(60000),
            });
            expect(res.status).toBe(200);
            let bytes = 0;
            const reader = res.body!.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
            }
            return bytes;
          };
          await read();
          await ds.transaction(async (em) => {
            // Відтворюємо стан після обрізання журналу за квотою. Загальний лічильник
            // може бути великим, але API читає лише першу й останні збережені спроби.
            await em.query(
              `INSERT INTO outbox_attempts ("eventId","tenantId",attempt,"senderId",outcome)
               SELECT $1,$2,attempt,'bench','http_error'
                 FROM (SELECT 1 AS attempt UNION ALL SELECT generate_series($3::int,$4::int)) retained`,
              [id, tenant.id, count - OUTBOX_ATTEMPT_HISTORY + 2, count],
            );
            await em.query('UPDATE outbox_events SET attempts=$2 WHERE id=$1', [
              id,
              count,
            ]);
          });
          type Memory = { rss: number; peakRss: number; peakHeap: number };
          const memory = async (command: string) => {
            const reply = message();
            child.send(command);
            return ((await reply) as [Memory])[0];
          };
          const before = await memory('baseline');
          const bytes = await read();
          const after = await memory('sample');
          expect(bytes).toBeLessThan(8 * 1024);
          console.log(
            JSON.stringify({
              count,
              retained: OUTBOX_ATTEMPT_HISTORY,
              query,
              bytes,
              baseRss: before.rss,
              peakRss: after.peakRss,
              deltaPeakRss: after.peakRss - before.peakRss,
              heapGrowth: after.peakHeap - before.peakHeap,
            }),
          );
        } finally {
          child.kill();
          await exited;
          await ds.query('DELETE FROM outbox_attempts WHERE "eventId"=$1', [
            id,
          ]);
          await ds.query('UPDATE outbox_events SET attempts=0 WHERE id=$1', [
            id,
          ]);
        }
      }
    },
  );
});
