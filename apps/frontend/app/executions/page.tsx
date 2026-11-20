import { ListPage } from '@/components/list-page';
export default function Executions({
  searchParams,
}: {
  searchParams: { workflowId?: string };
}) {
  return <ListPage workflowId={searchParams.workflowId} />;
}
