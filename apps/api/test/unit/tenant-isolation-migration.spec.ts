import { QueryRunner } from 'typeorm';
import { TenantIsolation1795100000000 } from '../../src/database/migrations/1795100000000-TenantIsolation';

/**
 * Модель ролей спирається на PostgreSQL 16: ADMIN OPTION творця ролі й `inherit_option` членств.
 * На старішому сервері CREATEROLE дає змогу призначити собі будь-яку роль, тож міграція зупиняється
 * раніше, ніж створить чи змінить ролі.
 */
describe('TenantIsolation server requirements', () => {
  it('refuses PostgreSQL older than 16 before touching any role', async () => {
    const sent: string[] = [];
    const query = jest.fn((sql: string) => {
      sent.push(sql);
      if (/rolsuper AS superuser/.test(sql))
        return Promise.resolve([{ superuser: true }]);
      if (/server_version_num/.test(sql))
        return Promise.resolve([{ version: 150008 }]);
      if (/count/.test(sql)) return Promise.resolve([{ count: '0' }]);
      return Promise.resolve([]);
    });

    await expect(
      new TenantIsolation1795100000000().up({
        query,
      } as unknown as QueryRunner),
    ).rejects.toThrow(/PostgreSQL 16/);
    expect(sent.filter((s) => /ROLE|GRANT|REVOKE/.test(s))).toEqual([]);
  });
});
