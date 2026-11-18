import { DynamicModule, Module } from '@nestjs/common';
import {
  DatabaseSecurityCheck,
  PROCESS_KIND,
  ProcessKind,
} from './database-security.check';
import { SystemDb } from './system-db';
import { TenantDb } from './tenant-db';

/**
 * Доступ до БД із контекстом тенанта (TenantDb), вузькі крос-тенантні виклики (SystemDb) і
 * перевірка ролі процесу на старті (DatabaseSecurityCheck).
 */
@Module({})
export class TenancyModule {
  static forRoot(kind: ProcessKind): DynamicModule {
    return {
      module: TenancyModule,
      providers: [
        { provide: PROCESS_KIND, useValue: kind },
        TenantDb,
        SystemDb,
        DatabaseSecurityCheck,
      ],
      exports: [TenantDb, SystemDb],
    };
  }
}
