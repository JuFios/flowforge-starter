import { ExecutionPage } from '@/components/execution-page';
export default function Execution({ params }: { params: { id: string } }) {
  return <ExecutionPage key={params.id} id={params.id} />;
}
