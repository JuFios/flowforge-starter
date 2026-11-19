import { MigrationInterface, QueryRunner } from 'typeorm';
import { fairClaimJobSql } from './1795800000000-FairPromotion';

/**
 * Ознака busy захоплення (README 3.3.5) без хибного «черга порожня»:
 *  - дозрілий тенант, якого промоція пропустила (його рядок обліку тримала коротка транзакція,
 *    SKIP LOCKED), — busy, а не порожня черга: воркер повторить одразу, а не через інтервал
 *    опитування;
 *  - бюджет промоції, вичерпаний рівно на останньому раунді (рівно PROMOTE_BUDGET дозрілих), не дає
 *    зайвого циклу: якщо дозрілих більше немає, захоплення одразу обирає задачу.
 * CREATE OR REPLACE зберігає власника (системна роль) і права EXECUTE функції.
 */
export class ClaimBusyReport1795900000000 implements MigrationInterface {
  name = 'ClaimBusyReport1795900000000';

  async up(runner: QueryRunner): Promise<void> {
    await runner.query(fairClaimJobSql(2));
  }

  async down(runner: QueryRunner): Promise<void> {
    await runner.query(fairClaimJobSql(1));
  }
}
