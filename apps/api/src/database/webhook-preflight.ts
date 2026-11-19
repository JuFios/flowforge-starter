import source from './data-source';
import { CONTEXT_BYTES, LEGACY_PATH } from '../engine/transform-profile';

/** Звіт перед перемиканням. Виводить тільки ідентифікатори і позиції кроків. */
async function main(): Promise<void> {
  await source.initialize();
  try {
    await source.transaction('REPEATABLE READ', async (em) => {
      await em.query('SET TRANSACTION READ ONLY');
      await em.query("SET LOCAL statement_timeout = '60s'");
      await em.query(
        `DECLARE review_workflows NO SCROLL CURSOR FOR
       SELECT w.id AS workflow, w.version, s.ordinality AS step, 'definition' AS reason
       FROM workflows w CROSS JOIN LATERAL jsonb_array_elements(w.steps) WITH ORDINALITY s(value,ordinality)
       WHERE s.value->>'type'='transform' AND NOT s.value ? 'language' AND s.value->>'expr' !~ $1`,
        [LEGACY_PATH.source],
      );
      await em.query(
        `DECLARE review_runs NO SCROLL CURSOR FOR
       SELECT e.id AS execution,e.status,s.ordinality AS step, r.status AS checkpoint, 'snapshot' AS reason
       FROM executions e JOIN workflow_versions v ON v.id=e."workflowVersionId" AND v."tenantId"=e."tenantId"
       CROSS JOIN LATERAL jsonb_array_elements(v.steps) WITH ORDINALITY s(value,ordinality)
       LEFT JOIN step_runs r ON r."executionId"=e.id AND r."tenantId"=e."tenantId" AND r."stepIndex"=s.ordinality-1
       WHERE e.status IN ('pending','running','failed') AND s.value->>'type'='transform'
         AND NOT s.value ? 'language' AND s.value->>'expr' !~ $1`,
        [LEGACY_PATH.source],
      );
      await em.query(
        `DECLARE review_size NO SCROLL CURSOR FOR
       SELECT e.id AS execution,e.status,'context_size_review' AS reason FROM executions e
       JOIN step_runs r ON r."executionId"=e.id AND r."tenantId"=e."tenantId"
       WHERE e.status IN ('pending','running','failed') GROUP BY e.id
       HAVING sum(octet_length(r.output::text))+octet_length(e.input::text)>$1`,
        [CONTEXT_BYTES],
      );
      let rows = 0;
      for (const cursor of ['review_workflows', 'review_runs', 'review_size']) {
        for (;;) {
          const page: unknown[] = await em.query(
            'FETCH FORWARD 100 FROM ' + cursor,
          );
          for (const entry of page) console.log(JSON.stringify(entry));
          rows += page.length;
          if (page.length < 100) break;
        }
      }
      console.log(JSON.stringify({ review: rows }));
    });
  } finally {
    await source.destroy();
  }
}
void main().catch(() => {
  console.error('Webhook upgrade preflight failed');
  process.exitCode = 1;
});
