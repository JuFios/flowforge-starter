type TestEnv = typeof import('../helpers/test-env');

/** Модуль test-env, завантажений з іншою адресою тестової БД. */
async function loadFor(url: string): Promise<TestEnv> {
  const saved = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = url;
  try {
    let loaded: TestEnv | undefined;
    await jest.isolateModulesAsync(async () => {
      loaded = await import('../helpers/test-env');
    });
    return loaded!;
  } finally {
    if (saved === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = saved;
  }
}

const RUN_A = 'postgres://owner:pw@localhost:5432/flowforge_a_test';
const RUN_B = 'postgres://owner:pw@localhost:5432/flowforge_b_test';

/**
 * Ролі Postgres спільні для кластера: два прогони з різними `TEST_DATABASE_URL` на одному кластері
 * не повинні ділити login-ролі (один змінив би пароль іншого чи видалив би їх у teardown).
 */
describe('cluster-wide names of an integration test run', () => {
  it('differ between test databases on one cluster', async () => {
    const [a, b] = [await loadFor(RUN_A), await loadFor(RUN_B)];
    expect(a.TEST_API_DB_USER).not.toBe(b.TEST_API_DB_USER);
    expect(a.TEST_WORKER_DB_USER).not.toBe(b.TEST_WORKER_DB_USER);
    expect(a.clusterScopedName('ff_scratch_test')).not.toBe(
      b.clusterScopedName('ff_scratch_test'),
    );
  });

  it('stay the same for one test database, so teardown finds the roles of a crashed run', async () => {
    const [first, again] = [await loadFor(RUN_A), await loadFor(RUN_A)];
    expect(first.TEST_API_DB_USER).toBe(again.TEST_API_DB_USER);
    expect(first.TEST_WORKER_DB_USER).toBe(again.TEST_WORKER_DB_USER);
  });

  it('stay valid Postgres identifiers and reject unsafe bases', async () => {
    const env = await loadFor(RUN_A);
    expect(env.TEST_API_DB_USER).toMatch(/^flowforge_api_test_[0-9a-f]{8}$/);
    expect(() => env.clusterScopedName('Robert"; DROP ROLE x; --')).toThrow(
      /invalid cluster-wide test name/,
    );
  });
});
