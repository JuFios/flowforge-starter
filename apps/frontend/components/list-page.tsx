'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, describeRejection, goToLogin } from '@/lib/client-api';
import type {
  Page,
  WorkflowSummary,
  ExecutionListItem,
  ExecutionStatus,
} from '@/lib/types';
export const statuses: Record<ExecutionStatus, string> = {
  pending: 'У черзі',
  running: 'Виконується',
  succeeded: 'Успішно',
  failed: 'Помилка',
};
export function Status({ value }: { value: ExecutionStatus }) {
  return (
    <span className={'status ' + (value === 'succeeded' ? 'success' : value)}>
      {statuses[value]}
    </span>
  );
}
type Item = WorkflowSummary | ExecutionListItem;
function Results({ path, workflows }: { path: string; workflows: boolean }) {
  const [items, setItems] = useState<Item[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, busy] = useState(true),
    [error, fail] = useState('');
  const active = useRef<AbortController>(),
    next = useRef<string | null>(null);
  async function read(after: string | null) {
    active.current?.abort();
    const ctrl = new AbortController();
    active.current = ctrl;
    busy(true);
    fail('');
    const result = await apiRequest<Page<Item>>(
      'GET',
      path + (after ? '&cursor=' + encodeURIComponent(after) : ''),
      { signal: ctrl.signal },
    );
    if (ctrl.signal.aborted) return;
    busy(false);
    if (result.kind === 'session_expired') return goToLogin();
    if (result.kind === 'ok') {
      setItems((old) =>
        after ? [...old, ...result.data.items] : result.data.items,
      );
      next.current = result.data.nextCursor;
      setCursor(next.current);
    } else if (result.kind !== 'aborted')
      fail(
        result.kind === 'rejected' ? describeRejection(result) : result.message,
      );
  }
  useEffect(() => {
    void read(null);
    function online() {
      void read(next.current);
    }
    window.addEventListener('online', online);
    return () => {
      active.current?.abort();
      window.removeEventListener('online', online);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- батько перемонтовує список за ключем повного запиту
  }, []);
  return (
    <section
      aria-label={workflows ? 'Список процесів' : 'Список виконань'}
      aria-busy={loading}
    >
      {items.map((item) =>
        'enabled' in item ? (
          <article className="row" key={item.id}>
            <div>
              <Link href={'/workflows/' + item.id}>{item.name}</Link>
              <small>
                Версія {item.version} · {item.cron ?? 'Без розкладу'}
              </small>
            </div>
            <span className="status">
              {item.enabled ? 'Увімкнено' : 'Вимкнено'}
            </span>
          </article>
        ) : (
          <article className="row" key={item.id}>
            <div>
              <Link href={'/executions/' + item.id}>
                {item.workflowName ?? 'Видалений процес'}
              </Link>
              <small>
                {new Date(item.createdAt).toLocaleString('uk-UA')} ·{' '}
                {item.id.slice(0, 8)}
              </small>
            </div>
            <Status value={item.status} />
          </article>
        ),
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="secondary" onClick={() => read(cursor)}>
            Повторити
          </button>
        </p>
      )}
      {loading && <p role="status">Завантаження…</p>}
      {!loading && !error && !items.length && (
        <div className="panel">
          {workflows
            ? 'Процесів ще немає. Створіть перший процес.'
            : 'Виконань за цими умовами немає.'}
        </div>
      )}
      {cursor && !error && (
        <button
          className="secondary"
          disabled={loading}
          onClick={() => read(cursor)}
        >
          Завантажити ще
        </button>
      )}
    </section>
  );
}
export function ListPage({
  workflows = false,
  workflowId = '',
}: {
  workflows?: boolean;
  workflowId?: string;
}) {
  const [status, filter] = useState(''),
    [wf, setWf] = useState(workflowId),
    [form, setForm] = useState(workflowId);
  const query = new URLSearchParams({ limit: '30' });
  if (status) query.set('status', status);
  if (wf) query.set('workflowId', wf);
  const path = (workflows ? 'workflows' : 'executions') + '?' + query;
  return (
    <>
      <div className="toolbar">
        <h1>{workflows ? 'Процеси' : 'Виконання'}</h1>
        {workflows && (
          <Link className="button" href="/workflows/new">
            Створити процес
          </Link>
        )}
      </div>
      {!workflows && (
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setWf(form.trim());
          }}
        >
          <label>
            Статус
            <select value={status} onChange={(e) => filter(e.target.value)}>
              <option value="">Усі статуси</option>
              {Object.entries(statuses).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ідентифікатор процесу
            <input
              value={form}
              placeholder="UUID процесу"
              onChange={(e) => setForm(e.target.value)}
              maxLength={36}
            />
          </label>
          <button className="secondary">Застосувати</button>
        </form>
      )}
      <Results key={path} path={path} workflows={workflows} />
    </>
  );
}
