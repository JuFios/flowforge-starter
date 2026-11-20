import { Injectable, NotFoundException, StreamableFile } from '@nestjs/common';
import { Readable, addAbortSignal } from 'node:stream';
import { Execution, StepRun } from '../entities';
import { TenantDb } from '../tenancy/tenant-db';

const STEP_COLUMNS = `s."stepIndex",s."stepId",s.status,s.attempts,left(s.error,500) AS error,s."startedAt",s."finishedAt",s."wakeAt",pg_column_size(s.output) AS "outputBytes"`;

export interface ExecutionOverview {
  id: string;
  revision: string;
  workflowName: string | null;
  status: Execution['status'];
  steps: Array<
    Pick<
      StepRun,
      | 'stepId'
      | 'stepIndex'
      | 'status'
      | 'attempts'
      | 'error'
      | 'startedAt'
      | 'finishedAt'
      | 'wakeAt'
    > & { outputBytes: number | null }
  >;
}

/** Один знімок PostgreSQL для ревізії, стану виконання та його кроків. */
@Injectable()
export class ExecutionReader {
  constructor(private readonly db: TenantDb) {}
  async summary(tenantId: string, id: string, sessionId?: string) {
    return this.db.run(tenantId, async (em) => {
      const [row] = await em.query<ExecutionOverview[]>(
        `SELECT e.id,e."workflowId",e.revision::text,e.status,e.trigger,
        e."createdAt",e."finishedAt",e."scheduledAt",e."correlationId",left(e.error,500) AS error,
        w.name AS "workflowName",v.version AS "workflowVersion",pg_column_size(e.output) AS "outputBytes",pg_column_size(e.input) AS "inputBytes",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.step->>'id','type',a.step->>'type') ORDER BY a.pos)
          FROM jsonb_array_elements(v.steps) WITH ORDINALITY AS a(step,pos)), '[]'::jsonb) AS plan,
        COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r."stepIndex") FROM (
          SELECT ${STEP_COLUMNS} FROM step_runs s WHERE s."executionId"=e.id AND s."tenantId"=e."tenantId"
        ) r), '[]'::jsonb) AS steps
        FROM executions e LEFT JOIN workflows w ON w.id=e."workflowId" AND w."tenantId"=e."tenantId"
        LEFT JOIN workflow_versions v ON v.id=e."workflowVersionId" AND v."tenantId"=e."tenantId"
        WHERE e.id=$1 AND e."tenantId"=$2 AND ($3::uuid IS NULL OR EXISTS(
          SELECT 1 FROM browser_sessions b WHERE b.id=$3 AND b."tenantId"=e."tenantId" AND b."expiresAt">clock_timestamp()))`,
        [id, tenantId, sessionId ?? null],
      );
      if (!row) throw new NotFoundException('Виконання недоступне');
      return row;
    });
  }
  async step(tenantId: string, id: string, index: number) {
    return this.db.run(tenantId, async (em) => {
      const [step] = await em.query<Array<StepRun>>(
        `SELECT ${STEP_COLUMNS},s.output FROM step_runs s WHERE s."executionId"=$1 AND s."tenantId"=$2 AND s."stepIndex"=$3`,
        [id, tenantId, index],
      );
      if (!step) throw new NotFoundException('Крок не знайдено');
      return step;
    });
  }
  async output(tenantId: string, id: string) {
    return this.db.run(tenantId, async (em) => {
      const [row] = await em.query<Array<{ output: unknown }>>(
        'SELECT output FROM executions WHERE id=$1 AND "tenantId"=$2',
        [id, tenantId],
      );
      if (!row) throw new NotFoundException('Виконання не знайдено');
      return row;
    });
  }
  async detail(tenantId: string, id: string) {
    const execution = await this.db.run(tenantId, (em) =>
      em.findOneBy(Execution, { id, tenantId }),
    );
    if (!execution) throw new NotFoundException('Виконання не знайдено');
    const read = (after: number) =>
      this.db.run(tenantId, (em) =>
        em.query<StepRun[]>(
          `SELECT * FROM step_runs WHERE "executionId"=$1 AND "tenantId"=$2 AND "stepIndex">$3 ORDER BY "stepIndex" LIMIT 2`,
          [id, tenantId, after],
        ),
      );
    async function* json() {
      yield JSON.stringify(execution).slice(0, -1) + ',"steps":[';
      let after = -1;
      for (;;) {
        const rows = await read(after);
        for (const row of rows) {
          yield (after < 0 ? '' : ',') + JSON.stringify(row);
          after = row.stepIndex;
        }
        if (rows.length < 2) break;
      }
      yield ']}';
    }
    return new StreamableFile(
      addAbortSignal(
        AbortSignal.timeout(60_000),
        Readable.from(json(), { objectMode: false }),
      ),
      { type: 'application/json; charset=utf-8' },
    );
  }
}
