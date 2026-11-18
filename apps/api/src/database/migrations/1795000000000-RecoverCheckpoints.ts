import { MigrationInterface, QueryRunner } from 'typeorm';

export class RecoverCheckpoints1795000000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    const reason =
      'checkpoint cannot be matched to the original workflow definition';
    // У задач, захоплених до появи fencing, також немає lockToken.
    // Якщо першим знімком стала вже редагована версія, одного stepId замало:
    // визначення могло змінитися під тим самим id. У старих завершених рядків немає finishedAt.
    await queryRunner.query(
      `WITH ambiguous AS (
         SELECT e.id FROM executions e JOIN workflow_versions v ON v.id = e."workflowVersionId"
          WHERE e.status <> 'succeeded' AND EXISTS (
            SELECT FROM step_runs s WHERE s."executionId" = e.id
             AND (s."stepIndex" < 0 OR s."stepId" IS DISTINCT FROM (v.steps -> s."stepIndex" ->> 'id')
               OR (v.version > 1 AND s."finishedAt" IS NULL AND s."wakeAt" IS NULL
                   AND NOT EXISTS (SELECT FROM workflow_versions prior
                                    WHERE prior."workflowId" = v."workflowId" AND prior.version < v.version)
                   AND (s.status <> 'running' OR EXISTS (
                     SELECT FROM jobs old_job WHERE old_job."executionId" = e.id
                       AND old_job.status = 'running' AND old_job."lockToken" IS NULL))))
          )
       ), stopped AS (
         UPDATE executions e SET status = 'failed', "workflowVersionId" = NULL,
                error = $1, "finishedAt" = COALESCE(e."finishedAt", now())
           FROM ambiguous a WHERE e.id = a.id RETURNING e.id
       ), closed_steps AS (
         UPDATE step_runs s SET status = 'failed', error = $1, "finishedAt" = now()
           FROM stopped e WHERE s."executionId" = e.id AND
             (s.status = 'running' OR (s.status = 'failed' AND s."finishedAt" IS NULL
                AND s.error = 'original workflow definition is unknown'))
       )
       UPDATE jobs j SET status = 'failed', "lastError" = $1, "finishedAt" = now(),
              "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
         FROM stopped e WHERE j."executionId" = e.id AND j.status IN ('queued', 'running')`,
      [reason],
    );
    // Старий воркер фіксував успіх виконання і задачі окремими транзакціями.
    await queryRunner.query(
      `UPDATE jobs j SET status = 'done', "finishedAt" = COALESCE(e."finishedAt", now()),
              "lockedBy" = NULL, "lockedUntil" = NULL, "lockToken" = NULL
         FROM executions e WHERE e.id = j."executionId" AND e.status = 'succeeded'
           AND j.status IN ('queued', 'running')`,
    );
    // Старий чекпоінт залишав attempts=1 між кроками під тим самим lease.
    await queryRunner.query(
      `UPDATE jobs j SET attempts = 0 FROM executions e
         JOIN workflow_versions v ON v.id = e."workflowVersionId"
        WHERE j."executionId" = e.id AND j.status = 'running' AND j.attempts = 1
          AND EXISTS (SELECT FROM step_runs s WHERE s."executionId" = e.id AND s.status = 'succeeded'
                       AND s."stepIndex" < jsonb_array_length(v.steps) - 1)
          AND NOT EXISTS (SELECT FROM step_runs s WHERE s."executionId" = e.id AND
                          (s.status <> 'succeeded' OR s."stepIndex" = jsonb_array_length(v.steps) - 1))`,
    );
  }

  down(): Promise<void> {
    // Відкат схеми зберігає зафіксовані результати та рішення щодо неоднозначних виконань.
    return Promise.resolve();
  }
}
