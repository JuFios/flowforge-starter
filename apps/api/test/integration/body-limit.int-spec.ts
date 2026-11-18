import type { RunningApp } from '../helpers/app';

/** Ліміт тіла запиту задає конфігурація (HTTP_BODY_LIMIT), а не константа в коді. */
describe('HTTP body limit from the configuration', () => {
  let running: RunningApp;
  const saved = process.env.HTTP_BODY_LIMIT;

  beforeAll(async () => {
    // Оточення читається під час імпорту модуля застосунку, тож імпорт — після налаштування.
    process.env.HTTP_BODY_LIMIT = '70000';
    const { startApp } = await import('../helpers/app');
    running = await startApp();
  });

  afterAll(async () => {
    await running.close();
    if (saved === undefined) delete process.env.HTTP_BODY_LIMIT;
    else process.env.HTTP_BODY_LIMIT = saved;
  });

  /** JSON-тіло рівно `bytes` байт. */
  const bodyOf = (bytes: number) => {
    const envelope = JSON.stringify({ name: '' });
    return JSON.stringify({ name: 'x'.repeat(bytes - envelope.length) });
  };

  const post = (body: string) =>
    fetch(`${running.baseUrl}/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'ff_none' },
      body,
    });

  it('rejects a body above the configured limit with 413', async () => {
    const res = await post(bodyOf(70_001));
    expect(res.status).toBe(413);
  });

  it('accepts a body up to the configured limit for further processing', async () => {
    // Невідомий ключ — 401 від guard-а: тіло пройшло body-parser.
    const res = await post(bodyOf(70_000));
    expect(res.status).toBe(401);
  });
});
