'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
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
const triggers = { api: 'Вручну / API', cron: 'Розклад', webhook: 'Webhook' };

const dateTime = new Intl.DateTimeFormat('uk-UA', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

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
  const active = useRef<AbortController>();
  const interruptedPage = useRef<{ after: string | null }>();
  const read = useCallback(
    async (after: string | null) => {
      active.current?.abort();
      const ctrl = new AbortController();
      active.current = ctrl;
      interruptedPage.current = { after };
      busy(true);
      fail('');
      const result = await apiRequest<Page<Item>>(
        'GET',
        path + (after ? '&cursor=' + encodeURIComponent(after) : ''),
        { signal: ctrl.signal },
      );
      if (ctrl.signal.aborted) return;
      active.current = undefined;
      if (result.kind !== 'network') interruptedPage.current = undefined;
      busy(false);
      if (result.kind === 'session_expired') return goToLogin();
      if (result.kind === 'ok') {
        setItems((old) =>
          after ? [...old, ...result.data.items] : result.data.items,
        );
        setCursor(result.data.nextCursor);
      } else if (result.kind !== 'aborted')
        fail(
          result.kind === 'rejected'
            ? describeRejection(result)
            : result.message,
        );
    },
    [path],
  );
  useEffect(() => {
    void read(null);
    function online() {
      const page = interruptedPage.current;
      if (page) void read(page.after);
    }
    window.addEventListener('online', online);
    return () => {
      active.current?.abort();
      window.removeEventListener('online', online);
    };
  }, [read]);
  return (
    <section
      aria-label={workflows ? 'Список процесів' : 'Список виконань'}
      aria-busy={loading}
    >
      {items.length > 0 && (
        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th scope="col">Процес</th>
                <th className="wide-cell" scope="col">
                  {workflows ? 'Розклад' : 'Джерело'}
                </th>
                <th scope="col">Статус</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) =>
                'enabled' in item ? (
                  <tr key={item.id}>
                    <td>
                      <Link
                        className="record-link"
                        href={'/workflows/' + item.id}
                      >
                        {item.name}
                      </Link>
                      <small>Версія {item.version}</small>
                    </td>
                    <td className="wide-cell">
                      {item.cron ? (
                        <>
                          <code>{item.cron}</code>
                          <small>{item.timezone}</small>
                        </>
                      ) : (
                        <span className="muted">Без розкладу</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={'status' + (item.enabled ? ' success' : '')}
                      >
                        {item.enabled ? 'Увімкнено' : 'Вимкнено'}
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr key={item.id}>
                    <td>
                      <Link
                        className="record-link"
                        href={'/executions/' + item.id}
                      >
                        {item.workflowName ?? 'Видалений процес'}
                      </Link>
                      <small>
                        <time dateTime={item.createdAt}>
                          {dateTime.format(new Date(item.createdAt))}
                        </time>{' '}
                        · <code title={item.id}>{item.id.slice(0, 8)}</code>
                      </small>
                    </td>
                    <td className="wide-cell">{triggers[item.trigger]}</td>
                    <td>
                      <Status value={item.status} />
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      {error && (
        <div className="notice actions">
          <span role="alert">{error}</span>
          <button className="secondary" onClick={() => read(cursor)}>
            Повторити
          </button>
        </div>
      )}
      {loading && (
        <p className="list-note" role="status">
          Завантаження…
        </p>
      )}
      {!loading && !error && !items.length && (
        <div className="panel empty-state">
          <p>
            {workflows ? 'Процесів ще немає' : 'Виконань за цими умовами немає'}
          </p>
        </div>
      )}
      {cursor && !error && (
        <button
          className="secondary load-more"
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
      <div className="toolbar page-heading">
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
