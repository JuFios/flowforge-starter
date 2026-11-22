import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdtemp, open, rm, unlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAbortSignal } from 'node:stream';
import type { EntityManager } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import { EnvironmentVariables } from '../config/env.validation';
import { Execution, StepRun } from '../entities';
import { DetailInProgressException } from '../limits/limit-exceptions';
import { TenantDb } from '../tenancy/tenant-db';
import { MAX_DETAIL_BYTES } from './detail-limits';

const STEP_COLUMNS = `s."stepIndex",s."stepId",s.status,s.attempts,left(s.error,500) AS error,s."startedAt",s."finishedAt",s."wakeAt",pg_column_size(s.output) AS "outputBytes"`;
const DETAIL_TIMEOUT_MS = 60_000;

const unavailable = () =>
  new ServiceUnavailableException('Деталі виконання тимчасово недоступні');

/** Межі спільного пулу знімків інстансу API (DETAIL_* у env.validation.ts). */
export interface DetailLimits {
  maxConcurrent: number;
  maxPerTenant: number;
  diskBytes: number;
}

/** Знімок, що готується чи віддається: його місце в пулі й зарезервовані байти диска. */
export interface DetailLease {
  /** Резервує байти диска під наступну порцію; бюджет вичерпано — 503. */
  reserve(bytes: number): void;
  /** Повертає місце й байти в пул; повторний виклик нічого не змінює. */
  release(): void;
}

/**
 * Облік спільного пулу знімків `GET /executions/:id` інстансу API (docs/operations.md, «Спільні
 * пули API»). Кількість одночасних знімків і диск тимчасових файлів обмежені окремо; частка
 * одного тенанта не перевищує половини кожного ресурсу (перевірка конфігурації), тож повільний чи
 * надмірний клієнт одного тенанта не забирає маршрут в інших. Перевірки й зміни лічильників —
 * синхронні, тож паралельні запити не обходять меж.
 */
export class DetailCapacity {
  private active = 0;
  private reserved = 0;
  private readonly perTenant = new Map<string, number>();

  constructor(private readonly limits: DetailLimits) {}

  /** Займає місце знімка: межа тенанта — 429, зайнятий пул чи диск — 503. */
  acquire(tenantId: string): DetailLease {
    const own = this.perTenant.get(tenantId) ?? 0;
    if (own >= this.limits.maxPerTenant) throw new DetailInProgressException();
    if (
      this.active >= this.limits.maxConcurrent ||
      this.reserved >= this.limits.diskBytes
    )
      throw unavailable();
    this.active++;
    this.perTenant.set(tenantId, own + 1);
    let held = 0;
    let released = false;
    return {
      reserve: (bytes: number) => {
        if (released) throw unavailable();
        if (this.reserved + bytes > this.limits.diskBytes) throw unavailable();
        this.reserved += bytes;
        held += bytes;
      },
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.reserved -= held;
        const left = (this.perTenant.get(tenantId) ?? 1) - 1;
        if (left > 0) this.perTenant.set(tenantId, left);
        else this.perTenant.delete(tenantId);
      },
    };
  }
}

async function openDetailFile(): Promise<FileHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'flowforge-execution-'));
  let file: FileHandle | undefined;
  try {
    const path = join(dir, 'detail.json');
    file = await open(path, 'wx+', 0o600);
    await unlink(path);
    await rm(dir, { recursive: true });
    return file;
  } catch (error) {
    try {
      await file?.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    throw error;
  }
}

export interface ExecutionOverview {
  id: string;
  revision: string;
  terminalCycles: number;
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
  private readonly capacity: DetailCapacity;

  constructor(
    private readonly db: TenantDb,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.capacity = new DetailCapacity({
      maxConcurrent: config.get('DETAIL_MAX_CONCURRENT', { infer: true }),
      maxPerTenant: config.get('DETAIL_MAX_PER_TENANT', { infer: true }),
      diskBytes: config.get('DETAIL_DISK_BUDGET_BYTES', { infer: true }),
    });
  }
  async summary(tenantId: string, id: string, sessionId?: string) {
    return this.db.run(tenantId, async (em) => {
      const [row] = await em.query<ExecutionOverview[]>(
        `SELECT e.id,e."workflowId",e.revision::text,e."terminalCycles",e.status,e.trigger,
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
  async detail(tenantId: string, id: string, disconnect?: AbortSignal) {
    const expiresAt = performance.now() + DETAIL_TIMEOUT_MS;
    const deadline = AbortSignal.timeout(DETAIL_TIMEOUT_MS);
    const signal = disconnect
      ? AbortSignal.any([deadline, disconnect])
      : deadline;
    const checkDeadline = () => {
      if (signal.aborted || performance.now() >= expiresAt) throw unavailable();
    };
    const limitQuery = async (em: EntityManager) => {
      checkDeadline();
      const remaining = Math.max(1, Math.floor(expiresAt - performance.now()));
      await em.query(
        `SELECT pg_catalog.set_config('statement_timeout',
           LEAST(COALESCE(NULLIF(setting::integer, 0), $1), $1)::text, true)
         FROM pg_catalog.pg_settings WHERE name='statement_timeout'`,
        [remaining],
      );
      checkDeadline();
    };
    let file: FileHandle | undefined;
    let handedOff = false;
    const lease = this.capacity.acquire(tenantId);
    try {
      const snapshot = await openDetailFile().catch(() => {
        throw unavailable();
      });
      file = snapshot;
      let length = 0;
      const write = async (json: string) => {
        checkDeadline();
        const bytes = Buffer.byteLength(json);
        length += bytes;
        if (length > MAX_DETAIL_BYTES) throw unavailable();
        lease.reserve(bytes);
        await writeFile(snapshot, json, { signal }).catch(() => {
          throw unavailable();
        });
      };
      await this.db.snapshot(tenantId, async (em) => {
        await limitQuery(em);
        const execution = await em.findOneBy(Execution, { id, tenantId });
        if (!execution) throw new NotFoundException('Виконання не знайдено');
        await write(JSON.stringify(execution).slice(0, -1) + ',"steps":[');
        let after = -1;
        for (;;) {
          await limitQuery(em);
          const rows = await em.query<StepRun[]>(
            `SELECT * FROM step_runs WHERE "executionId"=$1 AND "tenantId"=$2 AND "stepIndex">$3 ORDER BY "stepIndex" LIMIT 2`,
            [id, tenantId, after],
          );
          for (const row of rows) {
            await write((after < 0 ? '' : ',') + JSON.stringify(row));
            after = row.stepIndex;
          }
          if (rows.length < 2) break;
        }
        await write(']}');
      });
      checkDeadline();
      const stream = addAbortSignal(
        signal,
        snapshot.createReadStream({ start: 0 }),
      );
      stream.once('close', () => lease.release());
      handedOff = true;
      return new StreamableFile(stream, {
        type: 'application/json; charset=utf-8',
        length,
      });
    } catch (err) {
      if (
        signal.aborted ||
        (err instanceof QueryFailedError &&
          (err.driverError as { code?: unknown }).code === '57014')
      )
        throw unavailable();
      throw err;
    } finally {
      if (!handedOff) {
        try {
          await file?.close();
        } finally {
          lease.release();
        }
      }
    }
  }
}
