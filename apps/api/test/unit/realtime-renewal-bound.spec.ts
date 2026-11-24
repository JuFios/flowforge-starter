import { MAX_REALTIME_CONNECTIONS } from '../../src/config/env.validation';
import { MAX_WATCHES_PER_RENEWAL } from '../../src/database/migrations/1797600000000-RealtimeWatches';

/**
 * Підписок інстансу не більше, ніж його сокетів (REALTIME_MAX_CONNECTIONS). Якщо межа одного
 * продовження менша за найбільше допустиме значення цієї змінної, продовження з усіма підписками
 * відмовляло б, і сповіщення для всіх переглянутих виконань інстансу зникали б.
 */
describe('realtime watch renewal bound', () => {
  it('accepts every watch an instance can hold at the largest allowed REALTIME_MAX_CONNECTIONS', () => {
    expect(MAX_WATCHES_PER_RENEWAL).toBeGreaterThanOrEqual(
      MAX_REALTIME_CONNECTIONS,
    );
  });
});
