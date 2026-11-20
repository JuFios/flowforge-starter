import { WorkflowDetail } from '@/components/workflow-detail';
import { serverApi } from '@/lib/api';
import { WorkflowView } from '@/lib/types';
export default async function Workflow({ params }: { params: { id: string } }) {
  const path = '/workflows/' + encodeURIComponent(params.id);
  const result = await serverApi<WorkflowView>(path, path);
  return result.ok ? (
    <WorkflowDetail wf={result.data} />
  ) : (
    <section className="panel">
      <h1>Процес недоступний</h1>
      <p role="alert">{result.message}</p>
      <a href={path}>Повторити читання</a>
    </section>
  );
}
