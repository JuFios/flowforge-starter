import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  ApiKeyGuard,
  TenantAuthGuard,
  TenantRequest,
} from '../../src/auth/api-key.guard';
import type { AuthFailureLimiter } from '../../src/limits/auth-failure.limiter';
import { SystemDb } from '../../src/tenancy/system-db';
import { createTenant, openTestDataSource, truncateAll } from '../helpers/db';
import { testApiDatabaseUrl } from '../helpers/test-env';

/**
 * Автентифікація запиту (docs/architecture.md, «Автентифікація запиту»): тенант і його ефективні
 * ліміти — одним викликом `auth_tenant` / `auth_session` під роллю API, без окремої транзакції
 * тенанта. Ліміти мають збігатися з `tenant_limits()` у контексті тенанта, бо обидва вирази
 * визначено окремо.
 */
describe('request authentication with the tenant limits in one call', () => {
  let owner: DataSource;
  let api: DataSource;
  const statements: string[] = [];
  const observer = {
    afterQuery: (event: { query: string }) => {
      statements.push(event.query.trim());
    },
  };
  const rejected = new UnauthorizedException('rejected');
  const failures = {
    reject: () => Promise.reject(rejected),
  } as unknown as AuthFailureLimiter;

  function context(headers: Record<string, string>) {
    const req = { headers } as unknown as TenantRequest;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { req, ctx };
  }

  async function authenticate(
    guard: ApiKeyGuard,
    headers: Record<string, string>,
  ) {
    const { req, ctx } = context(headers);
    statements.length = 0;
    api.subscribers.push(observer);
    try {
      await guard.canActivate(ctx);
      return { req, statements: [...statements] };
    } finally {
      api.subscribers.splice(api.subscribers.indexOf(observer), 1);
    }
  }

  async function limitsInContext(tenantId: string) {
    return api.transaction(async (em) => {
      await em.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        tenantId,
      ]);
      const [row]: unknown[] = await em.query('SELECT * FROM tenant_limits()');
      return row;
    });
  }

  async function newSession(tenantId: string, expiresInMs: number) {
    const token = `ffs_${randomBytes(32).toString('hex')}`;
    await owner.query(
      `INSERT INTO browser_sessions ("tenantId", "tokenHash", "expiresAt")
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [
        tenantId,
        createHash('sha256').update(token).digest(),
        expiresInMs / 1000,
      ],
    );
    return token;
  }

  beforeAll(async () => {
    owner = await openTestDataSource();
    api = await new DataSource({
      type: 'postgres',
      url: testApiDatabaseUrl(),
    }).initialize();
  });

  beforeEach(() => truncateAll(owner));

  afterAll(async () => {
    await truncateAll(owner);
    await api.destroy();
    await owner.destroy();
  });

  it('authenticates an API key and reads the effective limits in one statement', async () => {
    const { tenant, apiKey } = await createTenant(owner, 'plain');
    const guard = new ApiKeyGuard(new SystemDb(api), failures);
    const { req, statements } = await authenticate(guard, {
      'x-api-key': apiKey,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/FROM auth_tenant\(/);
    expect(req.tenant.id).toBe(tenant.id);
    expect(req.limits).toEqual(await limitsInContext(tenant.id));
  });

  it('returns the same limits as tenant_limits() for a tenant with overrides', async () => {
    const { tenant, apiKey } = await createTenant(owner, 'custom');
    await owner.query(
      `UPDATE tenants SET "maxConcurrentExecutions" = 3, "maxQueueSize" = 40, "rateLimit" = 50,
              "webhookRateLimit" = 60, "maxWorkflows" = 7, "maxOutboxEvents" = 80 WHERE id = $1`,
      [tenant.id],
    );
    const guard = new ApiKeyGuard(new SystemDb(api), failures);
    const { req } = await authenticate(guard, { 'x-api-key': apiKey });
    const expected = await limitsInContext(tenant.id);
    expect(req.limits).toEqual(expected);
    expect(req.limits).toMatchObject({
      maxRunning: 3,
      maxQueueSize: 40,
      rateLimit: 50,
      webhookRateLimit: 60,
      maxWorkflows: 7,
      maxOutboxEvents: 80,
    });
  });

  it('authenticates a browser session and reads the limits in one statement', async () => {
    const { tenant } = await createTenant(owner, 'browser');
    const token = await newSession(tenant.id, 60_000);
    const guard = new TenantAuthGuard(new SystemDb(api), failures);
    const { req, statements } = await authenticate(guard, {
      authorization: `Bearer ${token}`,
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/FROM auth_session\(/);
    expect(req.tenant.id).toBe(tenant.id);
    expect(req.sessionId).toEqual(expect.any(String));
    expect(req.limits).toEqual(await limitsInContext(tenant.id));
  });

  it('rejects unknown, malformed and oversized keys and expired sessions', async () => {
    const { tenant, apiKey } = await createTenant(owner, 'other');
    const expired = await newSession(tenant.id, -1_000);
    const apiGuard = new ApiKeyGuard(new SystemDb(api), failures);
    const eitherGuard = new TenantAuthGuard(new SystemDb(api), failures);
    for (const key of [`${apiKey}x`, 'ff_unknown', 'x'.repeat(10_000)])
      await expect(authenticate(apiGuard, { 'x-api-key': key })).rejects.toBe(
        rejected,
      );
    await expect(
      authenticate(eitherGuard, { authorization: `Bearer ${expired}` }),
    ).rejects.toBe(rejected);
  });
});
