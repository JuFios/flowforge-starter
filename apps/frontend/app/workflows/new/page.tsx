import { WorkflowEditor } from '@/components/workflow-editor';
import Link from 'next/link';
export default function NewWorkflow() {
  return (
    <>
      <Link className="heading-link" href="/workflows">
        ← Процеси
      </Link>
      <h1>Новий процес</h1>
      <WorkflowEditor />
    </>
  );
}
