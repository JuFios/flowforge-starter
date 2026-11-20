import { MigrationInterface, QueryRunner } from 'typeorm';

export class ExecutionRevision1796800000000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(
      'ALTER TABLE public.executions ADD revision bigint NOT NULL DEFAULT 0',
    );
    await runner.query(`CREATE FUNCTION public.bump_execution_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
      BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END $$`);
    await runner.query(`CREATE FUNCTION public.touch_step_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
      BEGIN UPDATE public.executions SET revision=revision+1 WHERE id=NEW."executionId" AND "tenantId"=NEW."tenantId"; RETURN NEW; END $$`);
    await runner.query(`CREATE FUNCTION public.notify_execution() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE row_id uuid; tenant uuid;
      BEGIN
        IF TG_OP='DELETE' THEN row_id:=OLD.id; tenant:=OLD."tenantId"; ELSE row_id:=NEW.id; tenant:=NEW."tenantId"; END IF;
        PERFORM pg_notify('ff_execution',tenant::text || ':' || row_id::text);
        RETURN NULL;
      END $$`);
    for (const fn of [
      'bump_execution_revision',
      'touch_step_execution',
      'notify_execution',
    ])
      await runner.query(`REVOKE ALL ON FUNCTION public.${fn}() FROM PUBLIC`);
    await runner.query(
      'CREATE TRIGGER bump_execution_revision BEFORE UPDATE ON public.executions FOR EACH ROW EXECUTE FUNCTION public.bump_execution_revision()',
    );
    await runner.query(
      'CREATE TRIGGER touch_step_execution AFTER INSERT OR UPDATE ON public.step_runs FOR EACH ROW EXECUTE FUNCTION public.touch_step_execution()',
    );
    await runner.query(
      'CREATE TRIGGER notify_execution AFTER INSERT OR UPDATE OR DELETE ON public.executions FOR EACH ROW EXECUTE FUNCTION public.notify_execution()',
    );
  }
  async down(runner: QueryRunner): Promise<void> {
    await runner.query('DROP TRIGGER touch_step_execution ON public.step_runs');
    await runner.query(
      'DROP TRIGGER bump_execution_revision ON public.executions',
    );
    await runner.query('DROP TRIGGER notify_execution ON public.executions');
    await runner.query(
      'DROP FUNCTION public.touch_step_execution(),public.bump_execution_revision(),public.notify_execution()',
    );
    await runner.query('ALTER TABLE public.executions DROP COLUMN revision');
  }
}
