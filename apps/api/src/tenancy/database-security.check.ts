import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from './roles';

/** Який процес запущено: від цього залежить, якою роллю він мусить ходити в БД. */
export type ProcessKind = 'api' | 'worker';
export const PROCESS_KIND = Symbol('PROCESS_KIND');

/**
 * Таблиці без RLS, до яких runtime-роль може мати доступ. Порожньо: службові таблиці
 * (`migrations`, лічильники) runtime-ролям недоступні взагалі, тож будь-яка доступна таблиця без
 * RLS — помилка конфігурації. Нова таблиця, додана без політики, зупинить старт.
 */
export const RLS_EXEMPT_TABLES: readonly string[] = [];

/**
 * Перевірка на старті API і воркера: процес не почне роботу, якщо його роль у Postgres обходить
 * RLS або належить іншому процесу. Без неї помилкова конфігурація (підключення суперкористувачем,
 * роль із BYPASSRLS, таблиця без політики) тихо вимкнула б ізоляцію тенантів. Вимкнути перевірку
 * не можна.
 */
@Injectable()
export class DatabaseSecurityCheck implements OnModuleInit {
  private readonly logger = new Logger(DatabaseSecurityCheck.name);

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(PROCESS_KIND) private readonly kind: ProcessKind,
  ) {}

  async onModuleInit(): Promise<void> {
    const problems = await this.findProblems();
    if (problems.length > 0)
      throw new Error(
        `database role is not safe for the ${this.kind} process:\n  ${problems.join('\n  ')}`,
      );
    this.logger.log(`database role checked for the ${this.kind} process`);
  }

  /** Перелік порушень (порожній — роль безпечна). Повідомлення без секретів. */
  async findProblems(): Promise<string[]> {
    const problems: string[] = [];
    const [self]: Array<{
      superuser: boolean;
      bypass: boolean;
      api: boolean;
      worker: boolean;
    }> = await this.ds.query(
      `SELECT r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              pg_has_role(current_user, $1, 'MEMBER') AS api,
              pg_has_role(current_user, $2, 'MEMBER') AS worker
         FROM pg_roles r WHERE r.rolname = current_user`,
      [API_ROLE, WORKER_ROLE],
    );
    if (self.superuser) problems.push('the role is a superuser');
    if (self.bypass) problems.push('the role has BYPASSRLS');

    const expected = this.kind === 'api' ? self.api : self.worker;
    const foreign = this.kind === 'api' ? self.worker : self.api;
    const expectedRole = this.kind === 'api' ? API_ROLE : WORKER_ROLE;
    const foreignRole = this.kind === 'api' ? WORKER_ROLE : API_ROLE;
    if (!expected) problems.push(`the role is not a member of ${expectedRole}`);
    if (foreign)
      problems.push(
        `the role is a member of ${foreignRole}, which belongs to the other process`,
      );

    const privileged: Array<{ name: string }> = await this.ds.query(
      `SELECT r.rolname AS name FROM pg_roles r
        WHERE r.rolname <> current_user
          AND (r.rolsuper OR r.rolbypassrls OR r.rolname = $1)
          AND pg_has_role(current_user, r.oid, 'MEMBER')
        ORDER BY 1`,
      [SYSTEM_ROLE],
    );
    for (const { name } of privileged)
      problems.push(`the role can act as the privileged role ${name}`);

    const owned: Array<{ name: string }> = await this.ds.query(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND pg_has_role(current_user, c.relowner, 'MEMBER')
        ORDER BY 1 LIMIT 20`,
    );
    for (const { name } of owned)
      problems.push(`the role owns (or can act as the owner of) ${name}`);

    const unprotected: Array<{ name: string }> = await this.ds.query(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
          AND (has_table_privilege(c.oid, 'SELECT') OR has_table_privilege(c.oid, 'INSERT')
               OR has_table_privilege(c.oid, 'UPDATE') OR has_table_privilege(c.oid, 'DELETE'))
          AND NOT (c.relrowsecurity AND c.relforcerowsecurity
                   AND EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid))
          AND c.relname <> ALL ($1)
        ORDER BY 1`,
      [RLS_EXEMPT_TABLES],
    );
    for (const { name } of unprotected)
      problems.push(
        `table ${name} is accessible without forced row-level security`,
      );
    return problems;
  }
}
