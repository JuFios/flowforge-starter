import { MigrationInterface, QueryRunner } from 'typeorm';
import { terminalOutboxSql } from './1796200000000-NotificationOutbox';

export class SerializeOutbox1796300000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    // Спершу зупиняємо переходи execution, потім зміни конфігурації й спроб доставки.
    await runner.query(
      'LOCK TABLE public.executions, public.notification_settings, public.outbox_events IN SHARE ROW EXCLUSIVE MODE',
    );
    await runner.query(terminalOutboxSql(true));
    await runner.query(`UPDATE public.outbox_events e SET status='cancelled', "leaseToken"=NULL, "leaseUntil"=NULL
      WHERE status IN ('pending','sending') AND NOT EXISTS (
        SELECT FROM public.notification_settings s WHERE s."tenantId"=e."tenantId")`);
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query(terminalOutboxSql(false));
  }
}
