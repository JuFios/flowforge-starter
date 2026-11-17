import { MigrationInterface, QueryRunner } from 'typeorm';

/** Колонки DEFAULT now(), які базова схема створила як `timestamp without time zone`. */
const COLUMNS: Array<[table: string, column: string]> = [
  ['tenants', 'createdAt'],
  ['workflows', 'createdAt'],
  ['executions', 'createdAt'],
  ['step_runs', 'startedAt'],
  ['jobs', 'createdAt'],
];

/**
 * `timestamp` → `timestamptz` для моментів створення/старту.
 *
 * Наявні значення записані через DEFAULT now(), тобто як «настінний» час у поясі сесії, а сесія
 * успадковує пояс сервера БД (клієнт pg його не задає). Тому значення інтерпретуються в поясі
 * сервера (`current_setting('TimeZone')`), а не в жорстко заданому UTC: для сервера в UTC (як у
 * docker-compose) результат той самий, для сервера в іншому поясі UTC зсунув би всі рядки.
 * Припущення: пояс сервера не змінювався відтоді, як рядки були записані.
 *
 * ALTER TYPE переписує таблицю й перебудовує індекси на колонці (executions: tenantId, createdAt)
 * під ACCESS EXCLUSIVE — на великих таблицях це вікно обслуговування.
 */
export class TimestampsWithTimeZone1794920300000 implements MigrationInterface {
  name = 'TimestampsWithTimeZone1794920300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP WITH TIME ZONE ` +
          `USING "${column}" AT TIME ZONE current_setting('TimeZone')`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, column] of [...COLUMNS].reverse()) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE TIMESTAMP ` +
          `USING "${column}" AT TIME ZONE current_setting('TimeZone')`,
      );
    }
  }
}
