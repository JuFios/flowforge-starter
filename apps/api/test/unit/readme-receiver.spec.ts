import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { signatureHeader } from '../../src/outbox/outbox-signature';

type Headers = Record<string, string | undefined>;
interface ReceiverTransaction {
  insertIfAbsent(id: string): Promise<boolean>;
  applyEvent(event: { id: string }): Promise<void>;
}
interface Receiver {
  verify(h: Headers, raw: Buffer, secrets: string[], now?: number): boolean;
  handle(
    h: Headers,
    raw: Buffer,
    secrets: string[],
    store: {
      transaction(
        fn: (tx: ReceiverTransaction) => Promise<number>,
      ): Promise<number>;
    },
  ): Promise<number>;
}

/** Приклад отримувача з README (блок після позначки `receiver-example`), виконаний як є. */
function receiverFromReadme(): Receiver {
  const docs = readFileSync(
    join(__dirname, '../../../../docs/operations.md'),
    'utf8',
  );
  const after = docs.split('receiver-example')[1] ?? '';
  const code = /```js\n([\s\S]*?)```/.exec(after)?.[1];
  if (!code)
    throw new Error('the receiver example is missing from docs/operations.md');
  const module = { exports: {} as unknown };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- виконуємо саме опублікований приклад
  new Function('require', 'module', code)(require, module);
  return module.exports as Receiver;
}

/** Сповіщення так, як його підписує відправник (той самий модуль, що й у воркері). */
function delivery(secrets: string[], timestamp: number, id = 'evt-1') {
  const raw = Buffer.from(
    JSON.stringify({ specVersion: 1, id, type: 'execution.succeeded' }),
  );
  return {
    raw,
    headers: {
      'x-flowforge-event-id': id,
      'x-flowforge-timestamp': String(timestamp),
      'x-flowforge-signature': signatureHeader(secrets, id, timestamp, raw),
    } as Headers,
  };
}

describe('the receiver example in README', () => {
  const receiver = receiverFromReadme();
  const now = 1_795_000_000;

  it('accepts a signed notification and rejects a wrong secret, a changed body and an old timestamp', () => {
    const { raw, headers } = delivery(['current'], now);
    expect(receiver.verify(headers, raw, ['current'], now)).toBe(true);
    expect(receiver.verify(headers, raw, ['other'], now)).toBe(false);
    expect(
      receiver.verify(
        headers,
        Buffer.concat([raw, Buffer.from(' ')]),
        ['current'],
        now,
      ),
    ).toBe(false);
    expect(receiver.verify(headers, raw, ['current'], now + 301)).toBe(false);
  });

  it('accepts either key while a rotation signs with both', () => {
    const { raw, headers } = delivery(['old', 'new'], now);
    expect(receiver.verify(headers, raw, ['new'], now)).toBe(true);
    expect(receiver.verify(headers, raw, ['old'], now)).toBe(true);
  });

  it('processes a repeated delivery of the same event once', async () => {
    let committed = new Set<string>();
    let effects = 0;
    let fail = true;
    const store = {
      async transaction(fn: (tx: ReceiverTransaction) => Promise<number>) {
        const pending = new Set(committed);
        let applied = 0;
        const result = await fn({
          insertIfAbsent: (id) =>
            Promise.resolve(pending.has(id) ? false : (pending.add(id), true)),
          applyEvent: () => {
            if (fail) return Promise.reject(new Error('write failed'));
            applied++;
            return Promise.resolve();
          },
        });
        committed = pending;
        effects += applied;
        return result;
      },
    };
    const nowSeconds = Math.floor(Date.now() / 1000);
    const first = delivery(['s'], nowSeconds);
    const again = delivery(['s'], nowSeconds + 1);
    await expect(
      receiver.handle(first.headers, first.raw, ['s'], store),
    ).rejects.toThrow('write failed');
    expect(committed.size).toBe(0);
    fail = false;
    expect(await receiver.handle(first.headers, first.raw, ['s'], store)).toBe(
      204,
    );
    expect(await receiver.handle(again.headers, again.raw, ['s'], store)).toBe(
      200,
    );
    expect(effects).toBe(1);
    expect(await receiver.handle(first.headers, first.raw, ['x'], store)).toBe(
      401,
    );
  });
});
