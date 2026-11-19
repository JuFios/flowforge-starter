import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UNSAFE_LOGIN_SQL, UNSAFE_GROUP_SQL } from './login-role-check';
import { API_ROLE, SYSTEM_ROLE, WORKER_ROLE } from './roles';
import { findPostureViolations } from './security-posture';

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
      login: string;
      tenant: string | null;
      superuser: boolean;
      bypass: boolean;
      authenticated: boolean;
      api: boolean;
      worker: boolean;
    }> = await this.ds.query(
      `SELECT current_setting('app.tenant_id', true) AS tenant,r.rolname AS login, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
              session_user = current_user
                AND (SELECT a.usesysid FROM pg_catalog.pg_stat_activity a
                      WHERE a.pid = pg_catalog.pg_backend_pid()) = r.oid AS authenticated,
              pg_has_role(current_user, $1, 'MEMBER') AS api,
              pg_has_role(current_user, $2, 'MEMBER') AS worker
         FROM pg_roles r WHERE r.rolname = current_user`,
      [API_ROLE, WORKER_ROLE],
    );
    if (self.tenant) problems.push('the session starts with a tenant context');
    if (self.superuser) problems.push('the role is a superuser');
    if (self.bypass) problems.push('the role has BYPASSRLS');
    // Сесія, автентифікована іншою роллю (startup-опція role, SET ROLE), лише видає себе за
    // runtime-роль: RESET ROLE повернув би їй права тієї ролі, з якою вона увійшла.
    if (!self.authenticated)
      problems.push(
        'the session runs as another role than it authenticated with',
      );

    const expected = this.kind === 'api' ? self.api : self.worker;
    const foreign = this.kind === 'api' ? self.worker : self.api;
    const expectedRole = this.kind === 'api' ? API_ROLE : WORKER_ROLE;
    const groupProblems: unknown[] = await this.ds.query(UNSAFE_GROUP_SQL, [
      expectedRole,
    ]);
    if (groupProblems.length)
      problems.push('unexpected runtime group privileges');
    const unsafe: unknown[] = await this.ds.query(UNSAFE_LOGIN_SQL, [
      self.login,
      expectedRole,
    ]);
    if (unsafe.length)
      problems.push(
        'unexpected login role privileges, ownership or membership',
      );
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
    // Сторонніх членів службових ролей (член будь-якої з них обходить ізоляцію, навіть якщо роль
    // процесу безпечна) звіряють інваріанти каталогу нижче (I-1).

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
          AND (has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
               OR has_table_privilege(c.oid, 'DELETE,TRUNCATE,TRIGGER'))
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
    // Інваріанти каталогу (README 3.3.4): дрейф після розгортання — чужий грант будь-якій ролі,
    // зайва політика, сесія під службовою роллю — зупиняє процес, як і `db:migrate`.
    problems.push(
      ...(await findPostureViolations((sql, params) =>
        this.ds.query(sql, params),
      )),
    );
    return problems;
  }
}
